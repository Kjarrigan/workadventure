import Axios from "axios";
import { PUSHER_URL, START_ROOM_URL } from "../Enum/EnvironmentVariable";
import { RoomConnection } from "./RoomConnection";
import type { OnConnectInterface, PositionInterface, ViewportInterface } from "./ConnexionModels";
import { GameConnexionTypes, urlManager } from "../Url/UrlManager";
import { localUserStore } from "./LocalUserStore";
import { CharacterTexture, LocalUser } from "./LocalUser";
import { Room } from "./Room";
import { _ServiceWorker } from "../Network/ServiceWorker";
import { loginSceneVisibleIframeStore } from "../Stores/LoginSceneStore";
import { userIsConnected } from "../Stores/MenuStore";
import { analyticsClient } from "../Administration/AnalyticsClient";

class ConnectionManager {
    private localUser!: LocalUser;

    private connexionType?: GameConnexionTypes;
    private reconnectingTimeout: NodeJS.Timeout | null = null;
    private _unloading: boolean = false;
    private authToken: string | null = null;
    private _currentRoom: Room | null = null;

    private serviceWorker?: _ServiceWorker;

    get unloading() {
        return this._unloading;
    }

    constructor() {
        window.addEventListener("beforeunload", () => {
            this._unloading = true;
            if (this.reconnectingTimeout) clearTimeout(this.reconnectingTimeout);
        });
    }

    /**
     * TODO fix me to be move in game manager
     */
    public loadOpenIDScreen() {
        const state = localUserStore.generateState();
        const nonce = localUserStore.generateNonce();
        localUserStore.setAuthToken(null);

        //TODO fix me to redirect this URL by pusher
        if (!this._currentRoom || !this._currentRoom.iframeAuthentication) {
            loginSceneVisibleIframeStore.set(false);
            return null;
        }
        const redirectUrl = `${this._currentRoom.iframeAuthentication}?state=${state}&nonce=${nonce}&playUri=${this._currentRoom.key}`;
        window.location.assign(redirectUrl);
        return redirectUrl;
    }

    /**
     * Logout
     */
    public async logout() {
        //user logout, set connected store for menu at false
        userIsConnected.set(false);

        //Logout user in pusher and hydra
        const token = localUserStore.getAuthToken();
        const { authToken } = await Axios.get(`${PUSHER_URL}/logout-callback`, { params: { token } }).then(
            (res) => res.data
        );
        localUserStore.setAuthToken(null);

        //Go on login page can permit to clear token and start authentication process
        window.location.assign("/login");
    }

    /**
     * Tries to login to the node server and return the starting map url to be loaded
     */
    public async initGameConnexion(): Promise<Room> {
        const connexionType = urlManager.getGameConnexionType();
        this.connexionType = connexionType;
        this._currentRoom = null;
        if (connexionType === GameConnexionTypes.login) {
            this._currentRoom = await Room.createRoom(new URL(localUserStore.getLastRoomUrl()));
            if (this.loadOpenIDScreen() !== null) {
                return Promise.reject(new Error("You will be redirect on login page"));
            }
            urlManager.pushRoomIdToUrl(this._currentRoom);
        } else if (connexionType === GameConnexionTypes.jwt) {
            const urlParams = new URLSearchParams(window.location.search);
            const code = urlParams.get("code");
            const state = urlParams.get("state");
            if (!state || !localUserStore.verifyState(state)) {
                throw "Could not validate state!";
            }
            if (!code) {
                throw "No Auth code provided";
            }
            localUserStore.setCode(code);
            this._currentRoom = await Room.createRoom(new URL(localUserStore.getLastRoomUrl()));
            try {
                await this.checkAuthUserConnexion();
                analyticsClient.loggedWithSso();
            } catch (err) {
                console.error(err);
                this.loadOpenIDScreen();
                return Promise.reject(new Error("You will be redirect on login page"));
            }
            urlManager.pushRoomIdToUrl(this._currentRoom);
        } else if (connexionType === GameConnexionTypes.register) {
            //@deprecated
            const organizationMemberToken = urlManager.getOrganizationToken();
            const data = await Axios.post(`${PUSHER_URL}/register`, { organizationMemberToken }).then(
                (res) => res.data
            );
            this.localUser = new LocalUser(data.userUuid, data.textures);
            this.authToken = data.authToken;
            localUserStore.saveUser(this.localUser);
            localUserStore.setAuthToken(this.authToken);
            analyticsClient.loggedWithToken();

            const roomUrl = data.roomUrl;

            this._currentRoom = await Room.createRoom(
                new URL(
                    window.location.protocol +
                        "//" +
                        window.location.host +
                        roomUrl +
                        window.location.search +
                        window.location.hash
                )
            );
            urlManager.pushRoomIdToUrl(this._currentRoom);
        } else if (
            connexionType === GameConnexionTypes.organization ||
            connexionType === GameConnexionTypes.anonymous ||
            connexionType === GameConnexionTypes.empty
        ) {
            this.authToken = localUserStore.getAuthToken();
            //todo: add here some kind of warning if authToken has expired.
            if (!this.authToken) {
                await this.anonymousLogin();
            } else {
                try {
                    await this.checkAuthUserConnexion();
                } catch (err) {
                    console.error(err);
                }
            }
            this.localUser = localUserStore.getLocalUser() as LocalUser; //if authToken exist in localStorage then localUser cannot be null

            let roomPath: string;
            if (connexionType === GameConnexionTypes.empty) {
                roomPath = localUserStore.getLastRoomUrl();
                //get last room path from cache api
                try {
                    const lastRoomUrl = await localUserStore.getLastRoomUrlCacheApi();
                    if (lastRoomUrl != undefined) {
                        roomPath = lastRoomUrl;
                    }
                } catch (err) {
                    console.error(err);
                }
            } else {
                roomPath =
                    window.location.protocol +
                    "//" +
                    window.location.host +
                    window.location.pathname +
                    window.location.search +
                    window.location.hash;
            }

            //get detail map for anonymous login and set texture in local storage
            this._currentRoom = await Room.createRoom(new URL(roomPath));
            if (this._currentRoom.textures != undefined && this._currentRoom.textures.length > 0) {
                //check if texture was changed
                if (this.localUser.textures.length === 0) {
                    this.localUser.textures = this._currentRoom.textures;
                } else {
                    this._currentRoom.textures.forEach((newTexture) => {
                        const alreadyExistTexture = this.localUser.textures.find((c) => newTexture.id === c.id);
                        if (this.localUser.textures.findIndex((c) => newTexture.id === c.id) !== -1) {
                            return;
                        }
                        this.localUser.textures.push(newTexture);
                    });
                }
                localUserStore.saveUser(this.localUser);
            }
        }
        if (this._currentRoom == undefined) {
            return Promise.reject(new Error("Invalid URL"));
        }
        if (this.localUser) {
            analyticsClient.identifyUser(this.localUser.uuid);
        }

        this.serviceWorker = new _ServiceWorker();
        return Promise.resolve(this._currentRoom);
    }

    public async anonymousLogin(isBenchmark: boolean = false): Promise<void> {
        const data = await Axios.post(`${PUSHER_URL}/anonymLogin`).then((res) => res.data);
        this.localUser = new LocalUser(data.userUuid, []);
        this.authToken = data.authToken;
        if (!isBenchmark) {
            // In benchmark, we don't have a local storage.
            localUserStore.saveUser(this.localUser);
            localUserStore.setAuthToken(this.authToken);
        }
    }

    public initBenchmark(): void {
        this.localUser = new LocalUser("", []);
    }

    public connectToRoomSocket(
        roomUrl: string,
        name: string,
        characterLayers: string[],
        position: PositionInterface,
        viewport: ViewportInterface,
        companion: string | null
    ): Promise<OnConnectInterface> {
        return new Promise<OnConnectInterface>((resolve, reject) => {
            const connection = new RoomConnection(
                this.authToken,
                roomUrl,
                name,
                characterLayers,
                position,
                viewport,
                companion
            );

            connection.onConnectError((error: object) => {
                console.log("An error occurred while connecting to socket server. Retrying");
                reject(error);
            });

            connection.onConnectingError((event: CloseEvent) => {
                console.log("An error occurred while connecting to socket server. Retrying");
                reject(
                    new Error(
                        "An error occurred while connecting to socket server. Retrying. Code: " +
                            event.code +
                            ", Reason: " +
                            event.reason
                    )
                );
            });

            connection.onConnect((connect: OnConnectInterface) => {
                resolve(connect);
            });
        }).catch((err) => {
            // Let's retry in 4-6 seconds
            return new Promise<OnConnectInterface>((resolve, reject) => {
                this.reconnectingTimeout = setTimeout(() => {
                    //todo: allow a way to break recursion?
                    //todo: find a way to avoid recursive function. Otherwise, the call stack will grow indefinitely.
                    this.connectToRoomSocket(roomUrl, name, characterLayers, position, viewport, companion).then(
                        (connection) => resolve(connection)
                    );
                }, 4000 + Math.floor(Math.random() * 2000));
            });
        });
    }

    get getConnexionType() {
        return this.connexionType;
    }

    async checkAuthUserConnexion() {
        //set connected store for menu at false
        userIsConnected.set(false);

        const state = localUserStore.getState();
        const code = localUserStore.getCode();
        if (!state || !localUserStore.verifyState(state)) {
            throw "Could not validate state!";
        }
        if (!code) {
            throw "No Auth code provided";
        }
        const nonce = localUserStore.getNonce();
        const token = localUserStore.getAuthToken();
        const { authToken } = await Axios.get(`${PUSHER_URL}/login-callback`, { params: { code, nonce, token } }).then(
            (res) => res.data
        );
        localUserStore.setAuthToken(authToken);
        this.authToken = authToken;

        //user connected, set connected store for menu at true
        userIsConnected.set(true);
    }

    get currentRoom() {
        return this._currentRoom;
    }
}

export const connectionManager = new ConnectionManager();
