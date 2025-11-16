import { io } from "socket.io-client"
class SocketManager {
  static instance
  socket = null

  constructor() {
    if (SocketManager.instance) return SocketManager.instance
    SocketManager.instance = this
    this.connect(process.env.SERVER_URL)
  }

  connect(url, options = {}) {
    if (!this.socket) {
      this.socket = io(url, {
        auth: { token: process.env.TOKEN },
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 1000,
        ...options,
      })
    }


    this.socket.on("connect", () => {
    });

    this.socket.on("disconnect", (reason) => {
    });

    this.socket.on("connect_error", (err) => {
      // console.error("⚠️ Connection error:", err.message);
    })

    return this.socket
  }

  getSocket() {
    if (!this.socket) throw new Error("Socket not connected yet!")
    return this.socket
  }

  emit(event, data) {
    if (!this.socket) return
    this.socket.emit(event, data)
  }

  on(event, callback) {
    if (!this.socket) return
    this.socket.on(event, callback)
  }

  disconnect() {
    if (this.socket) {
      this.socket.disconnect()
      this.socket = null
    }
  }
}

export default new SocketManager()
