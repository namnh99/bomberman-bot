# 🤖 Bomberman Bot

Advanced AI bot for Bomberman game with intelligent pathfinding, escape strategies, and combat tactics.

## 🚀 Quick Start

### Option 1: Docker (Recommended)

```bash
# 1. Setup environment
cp .env.example .env
# Edit .env with your credentials

# 2. Run with Docker Compose
docker compose up -d

# 3. View logs
docker compose logs -f bot
```

Or use Makefile shortcuts:
```bash
make up    # Start bot
make logs  # View logs
make down  # Stop bot
```

See [DOCKER.md](DOCKER.md) for complete Docker documentation.

### Option 2: Node.js

```bash
# 1. Install dependencies
npm install

# 2. Setup environment
cp .env.example .env
# Edit .env with your credentials

# 3. Run bot
npm start

# Or with hot reload (development)
npm run dev
```

## 📋 Requirements

- Node.js 20+ (if running locally)
- Docker & Docker Compose (if using Docker)
- Valid game server credentials

## 🛠️ Development

### With Docker (Hot Reload)
```bash
make dev-up    # Start in dev mode
make dev-logs  # View logs
```

### Without Docker
```bash
npm run dev    # Run with hot reload
npm run debug  # Run with debugger
```

## 📁 Project Structure

```
├── src/
│   ├── bot/
│   │   ├── agent.js              # Main decision logic
│   │   ├── pathfinding/          # Pathfinding algorithms
│   │   └── strategy/             # Combat & escape strategies
│   ├── socket/                   # WebSocket management
│   └── utils/                    # Utilities & constants
├── Dockerfile                    # Production Docker image
├── Dockerfile.dev                # Development Docker image
├── docker-compose.yml            # Production compose
├── docker-compose.dev.yml        # Development compose
└── Makefile                      # Quick commands
```

## 🎮 Features

- ✅ Advanced pathfinding with timing-based safety calculations
- ✅ Multi-bomb escape strategies
- ✅ Dynamic item prioritization
- ✅ Enemy pursuit and trap detection
- ✅ Chain reaction optimization
- ✅ Anti-deadlock protection
- ✅ Zone control strategies

## 🐳 Docker Commands

```bash
# Production
make up          # Start bot
make down        # Stop bot
make logs        # View logs
make restart     # Restart bot
make shell       # Open shell in container

# Development
make dev-up      # Start with hot reload
make dev-logs    # View dev logs
make dev-down    # Stop dev bot

# Utilities
make stats       # Resource usage
make clean       # Clean everything
```

## 📚 Documentation

- [DOCKER.md](DOCKER.md) - Complete Docker setup guide
- [ARCHITECTURE_DIAGRAM.md](documents/ARCHITECTURE_DIAGRAM.md) - System architecture
- [COMPLETE_DOCUMENTATION.md](documents/COMPLETE_DOCUMENTATION.md) - Detailed documentation

## 🔒 Environment Variables

Required in `.env`:
```bash
SOCKET_SERVER=your_server_url
TOKEN=your_auth_token
```

## 📊 Performance

- Memory usage: ~50-100MB
- CPU usage: Minimal when idle
- Docker image: ~150MB (Alpine Linux)
- Startup time: ~2-5 seconds

## 🤝 Contributing

1. Create feature branch
2. Test with `make dev-up`
3. Submit pull request

## 📄 License

ISC
