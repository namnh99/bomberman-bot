import socketManager from "./socket/SocketManager.js";

const socket = socketManager.getSocket();

// Khi socket đã kết nối
socket.on("connect", () => {
  console.log("✅ Connected to server with ID:", socket.id);

  // Gửi event join để tham gia phòng chơi
  socket.emit("join", {}); // theo tài liệu, data là object rỗng
  console.log("🚀 Sent join event");
});

// Lắng nghe các event từ server
socket.on("user", (state) => {
  console.log("👤 user:", state);
});

socket.on("join", (state) => {
  console.log("📢 join:", state);
});

socket.on("disconnect", (reason) => {
  console.log("❌ Disconnected:", reason);
});
