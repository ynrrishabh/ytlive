const mongoose = require('mongoose');

const projectSchema = new mongoose.Schema({
  projectId: {
    type: String,
    required: true,
    unique: true
  },
  googleClientId: {
    type: String,
    required: true
  },
  googleClientSecret: {
    type: String,
    required: true
  },
  youtubeApiKey: {
    type: String,
    required: true
  },
  geminiApiKey: {
    type: String,
    required: true
  },
  oauthTokens: {
    access_token: String,
    refresh_token: String,
    expiry_date: Date
  },
  isActive: {
    type: Boolean,
    default: true
  },
  priority: {
    type: Number,
    default: 1
  },
  quotaExceeded: {
    type: Boolean,
    default: false
  },
  quotaExceededAt: {
    type: Date
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  lastUsed: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('Project', projectSchema); 