# YouTube Live Chat Bot

A powerful YouTube Live Chat bot built with Node.js and MongoDB that provides features similar to Streamlabs, including points system, leaderboard, and minigames.

## Features

- 🔐 Google OAuth2 Authentication
- 💬 Real-time chat monitoring
- ⏱️ Auto-messages with configurable intervals
- 🎮 Points system and leaderboard
- 🎲 Gambling minigame
- 🤖 AI-powered /ask command using Gemini API
- 📊 Watch time tracking
- 🏆 Points and watch time leaderboards

## Prerequisites

- Node.js (v14 or higher)
- MongoDB database
- Google Cloud Platform account with YouTube Data API enabled
- Gemini API key

## Setup

1. Clone the repository:
```bash
git clone <repository-url>
cd ytlive
```

2. Install dependencies:
```bash
npm install
```

3. Create a `.env` file in the root directory with the following variables:
```env
GOOGLE_CLIENT_ID=your_client_id_here
GOOGLE_CLIENT_SECRET=your_client_secret_here
GOOGLE_REDIRECT_URI=http://localhost:3000/auth/callback
MONGO_URI=your_mongodb_uri_here
GEMINI_API_KEY=your_gemini_api_key_here
PORT=3000
NODE_ENV=development
```

4. Start the server:
```bash
npm start
```

## API Endpoints

### Authentication
- `GET /auth/login` - Get Google OAuth URL
- `GET /auth/callback` - Handle OAuth callback

### Bot Control
- `POST /bot/start/:channelId` - Start the bot for a channel
- `POST /bot/stop/:channelId` - Stop the bot for a channel
- `POST /bot/auto-message/:channelId` - Configure auto messages
- `GET /bot/leaderboard/:channelId` - Get points/watch time leaderboard

## Chat Commands

- `!points` - Check your points and watch time
- `!gamble <amount>` - Gamble your points
- `!roll <amount>` - Alternative to gamble command
- `/ask <question>` - Ask the AI a question

## Deployment

The application is designed to be deployed on Render's free tier. Follow these steps:

1. Push your code to GitHub
2. Create a new Web Service on Render
3. Connect your GitHub repository
4. Add the environment variables
5. Deploy!

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is licensed under the MIT License - see the LICENSE file for details. 