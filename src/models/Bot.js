const mongoose = require('mongoose');

const botSchema = new mongoose.Schema({
  botId: {
    type: String,
    required: true,
    unique: true
  },
  accessToken: {
    type: String,
    required: true
  },
  refreshToken: {
    type: String,
    required: true
  },
  tokenExpiry: {
    type: Date,
    required: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Ensure botId is unique
botSchema.index({ botId: 1 }, { unique: true });

module.exports = mongoose.model('Bot', botSchema); 