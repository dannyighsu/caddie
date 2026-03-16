# Northstar

AI-powered personal assistant that integrates with Google Calendar, Notion, and Slack to help manage tasks and communications.

## Features

- **OAuth Integration**: Connect to Google Calendar, Notion, and Slack
- **AI Agent**: AI agent for daily check-ins and task management
- **Scheduled Check-ins**: Redis-based scheduling with Azure Functions triggers
- **Message Handling**: Receive and respond to messages via ChatKit/Porter

## Architecture

```
northstar/
├── app/                    # Next.js App Router
│   ├── api/               # API Routes
│   │   ├── auth/          # OAuth flows (Google, Notion, Slack)
│   │   ├── agent/         # Agent execution endpoints
│   │   └── scheduler/     # Check-in scheduling
│   ├── settings/          # Settings page
│   └── page.tsx           # Dashboard
├── lib/
│   ├── config/            # Environment configuration
│   ├── clients/           # External service clients (Redis, Porter)
│   ├── db/                # Database client and repositories
│   ├── services/          # Business logic services
│   └── agents/            # AI agent definitions
└── azure-functions/       # Azure Functions for scheduled triggers
```

## Prerequisites

- Node.js 20+
- PostgreSQL (local or Azure)
- Redis (local or Azure Cache for Redis)
- OAuth credentials for Google, Notion, and Slack

## Setup

### 1. Install dependencies

```bash
pnpm install
```

### 2. Configure environment

Copy the example environment file and fill in your values:

```bash
cp .env.local.example .env.local
```

### 3. Set up the database

Start a local PostgreSQL instance and create the database:

```bash
createdb northstar
```

Run migrations:

```bash
pnpm run db:migrate
```

### 4. Start Redis

```bash
# Using Docker
docker run -d -p 6379:6379 redis

# Or using Homebrew on macOS
brew services start redis
```

### 5. Run the development server

```bash
pnpm run dev
```

Open [http://localhost:3000](http://localhost:3000) to access the dashboard.

## OAuth Setup

### Google Calendar

1. Go to [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
2. Create OAuth 2.0 credentials
3. Add `http://localhost:3000/api/auth/google/callback` as authorized redirect URI
4. Enable the Google Calendar API

### Notion

1. Go to [Notion Integrations](https://www.notion.so/my-integrations)
2. Create a new integration
3. Set redirect URI to `http://localhost:3000/api/auth/notion/callback`

### Slack

1. Go to [Slack API](https://api.slack.com/apps)
2. Create a new app
3. Add OAuth redirect URL: `http://localhost:3000/api/auth/slack/callback`
4. Configure required scopes (see `.env.local.example`)

## ConstellationFS Workspace

The agent stores task records in a ConstellationFS workspace. Set `WORKSPACE_ROOT` in your environment to point to the workspace directory.

Task files are organized by month:
```
{WORKSPACE_ROOT}/tasks/
├── 2025-12/
│   ├── 1_monday.txt
│   ├── 2_tuesday.txt
│   └── ...
└── 2026-01/
    └── ...
```

## API Endpoints

### Authentication
- `GET /api/auth/google` - Start Google OAuth flow
- `GET /api/auth/notion` - Start Notion OAuth flow
- `GET /api/auth/slack` - Start Slack OAuth flow
- `GET /api/auth/status` - Get connection status for all providers
- `POST /api/auth/disconnect` - Disconnect a provider

### Agent
- `POST /api/agent/run` - Trigger an agent check-in
- `POST /api/agent/continue` - Continue a conversation with the agent
- `POST /api/agent/webhook` - Webhook for incoming messages from ChatKit

### Scheduler
- `GET /api/scheduler/next` - Get next scheduled check-in
- `POST /api/scheduler/schedule` - Schedule a new check-in
- `POST /api/scheduler/trigger` - Process due check-ins (called by Azure Functions)

## Production Deployment (Azure)

### Azure App Service

1. Create an Azure App Service (Node.js 20)
2. Configure environment variables from `.env.production.example`
3. Deploy the Next.js app

### Azure Cache for Redis

1. Create an Azure Cache for Redis instance
2. Update `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`, and `REDIS_USE_SSL`

### Azure Database for PostgreSQL

1. Create an Azure Database for PostgreSQL Flexible Server
2. Update `POSTGRES_URL` with the connection string

### Azure Functions

1. Navigate to `azure-functions/`
2. Deploy to Azure Functions
3. Configure `NORTHSTAR_API_URL` to point to your App Service

## License

Private
