import { io } from "socket.io-client";
import { SERVER_URL, TOKEN } from "../constants/index.js";

class SocketManager {
  static instance;
  socket = null;

  constructor() {
    if (SocketManager.instance) return SocketManager.instance;
    SocketManager.instance = this;
    this.connect(SERVER_URL);
  }

  connect(url, options = {}) {
    if (!this.socket) {
      this.socket = io(url, {
        auth: { token: TOKEN },
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 1000,
        ...options,
      });
    }

    console.log("🔌 Connecting to server:", url);

    this.socket.on("connect", () => {
      console.log("✅ Connected as:", this.socket.id);
      this.emit("join", {}); // Gửi join ngay khi kết nối
      console.log("🚀 Sent join event");
    });

    this.socket.on("disconnect", (reason) => {
      console.log("❌ Disconnected:", reason);
    });

    this.socket.on("connect_error", (err) => {
      console.error("⚠️ Connection error:", err.message);
    });

    return this.socket;
  }

  getSocket() {
    if (!this.socket) throw new Error("Socket not connected yet!");
    return this.socket;
  }

  emit(event, data) {
    if (!this.socket) return;
    this.socket.emit(event, data);
  }

  on(event, callback) {
    if (!this.socket) return;
    this.socket.on(event, callback);
  }

  disconnect() {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
  }
}

export default new SocketManager();
