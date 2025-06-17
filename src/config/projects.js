// Default project configurations
// These will be used to create initial projects in the database
const defaultProjects = [
  {
    projectId: "project-1",
    googleClientId: process.env.GOOGLE_CLIENT_ID_1 || process.env.GOOGLE_CLIENT_ID,
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET_1 || process.env.GOOGLE_CLIENT_SECRET,
    youtubeApiKey: process.env.YOUTUBE_API_KEY_1 || process.env.YOUTUBE_API_KEY,
    geminiApiKey: process.env.GEMINI_API_KEY_1 || process.env.GEMINI_API_KEY,
    priority: 1
  },
  {
    projectId: "project-2", 
    googleClientId: process.env.GOOGLE_CLIENT_ID_2,
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET_2,
    youtubeApiKey: process.env.YOUTUBE_API_KEY_2,
    geminiApiKey: process.env.GEMINI_API_KEY_2,
    priority: 2
  },
  {
    projectId: "project-3",
    googleClientId: process.env.GOOGLE_CLIENT_ID_3,
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET_3,
    youtubeApiKey: process.env.YOUTUBE_API_KEY_3,
    geminiApiKey: process.env.GEMINI_API_KEY_3,
    priority: 3
  }
];

module.exports = { defaultProjects }; 