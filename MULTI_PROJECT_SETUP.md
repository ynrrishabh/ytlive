# Multi-Project YouTube Live Chat Bot Setup

This bot now supports multiple Google Cloud projects to distribute API quota usage and provide higher limits.

## How It Works

- **Multiple Projects**: Create 3 Google Cloud projects (or more)
- **30k Total Quota**: Each project gets 10k tokens/day = 30k total
- **Automatic Rotation**: Bot switches between projects when quota is exceeded
- **OAuth Setup**: Each project needs separate OAuth authentication

## Setup Instructions

### 1. Create Google Cloud Projects

Create 3 Google Cloud projects:
- Project 1: `your-bot-project-1`
- Project 2: `your-bot-project-2` 
- Project 3: `your-bot-project-3`

### 2. Enable APIs in Each Project

For each project, enable:
- YouTube Data API v3
- Google Generative AI API

### 3. Create Credentials

For each project, create:
- **OAuth 2.0 Client ID** (for bot authentication)
- **API Key** (for YouTube API)
- **API Key** (for Gemini AI)

### 4. Set Environment Variables

Add these to your `.env` file:

```bash
# Project 1 (uses existing variables as fallback)
GOOGLE_CLIENT_ID_1=your-project-1-client-id
GOOGLE_CLIENT_SECRET_1=your-project-1-client-secret
YOUTUBE_API_KEY_1=your-project-1-youtube-api-key
GEMINI_API_KEY_1=your-project-1-gemini-api-key

# Project 2
GOOGLE_CLIENT_ID_2=your-project-2-client-id
GOOGLE_CLIENT_SECRET_2=your-project-2-client-secret
YOUTUBE_API_KEY_2=your-project-2-youtube-api-key
GEMINI_API_KEY_2=your-project-2-gemini-api-key

# Project 3
GOOGLE_CLIENT_ID_3=your-project-3-client-id
GOOGLE_CLIENT_SECRET_3=your-project-3-client-secret
YOUTUBE_API_KEY_3=your-project-3-youtube-api-key
GEMINI_API_KEY_3=your-project-3-gemini-api-key

# OAuth Redirect URI (same for all projects)
GOOGLE_REDIRECT_URI=http://localhost:3000/bot/oauth/callback
```

### 5. Start the Bot

```bash
npm start
```

### 6. Configure OAuth

1. Open `http://localhost:3000` in your browser
2. You'll see: "0/3 bot logins found. Please setup OAuth accounts:"
3. Click each OAuth link to authorize the bot
4. Complete all 3 OAuth flows
5. Bot will start automatically when all are configured

## Bot Operation

### Automatic Project Rotation
- Bot starts with Project 1
- When quota exceeded → switches to Project 2
- When Project 2 quota exceeded → switches to Project 3
- When all projects exhausted → waits for daily reset

### Quota Management
- Each project gets 10k tokens/day
- Quota resets at midnight (Google's timezone)
- Bot automatically detects quota exceeded errors
- No manual intervention needed

### OAuth Token Management
- OAuth tokens are stored in database
- Tokens automatically refresh when expired
- Each project maintains separate OAuth session

## Database Schema

```javascript
// Projects collection
{
  projectId: "project-1",
  googleClientId: "...",
  googleClientSecret: "...",
  youtubeApiKey: "...",
  geminiApiKey: "...",
  oauthTokens: {
    access_token: "...",
    refresh_token: "...",
    expiry_date: "..."
  },
  isActive: true,
  quotaExceeded: false,
  priority: 1
}
```

## Benefits

- **30k total quota** instead of 10k
- **Automatic failover** when quota exceeded
- **No downtime** during quota resets
- **Scalable** - add more projects anytime
- **User-friendly** setup process

## Troubleshooting

### "No OAuth accounts configured"
- Check environment variables are set correctly
- Ensure OAuth redirect URI matches in Google Console
- Verify API keys are valid

### "Quota exceeded" errors
- Normal behavior - bot will switch to next project
- Check if all projects have quota exceeded
- Wait for daily reset if all projects exhausted

### OAuth callback errors
- Ensure redirect URI is exactly: `http://localhost:3000/bot/oauth/callback`
- Check that OAuth consent screen is configured
- Verify client ID and secret are correct

## Adding More Projects

To add more projects:

1. Create new Google Cloud project
2. Add environment variables (GOOGLE_CLIENT_ID_4, etc.)
3. Restart bot
4. Complete OAuth setup for new project
5. Bot will automatically include new project in rotation 