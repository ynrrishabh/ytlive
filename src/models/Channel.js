const mongoose = require('mongoose');

const channelSchema = new mongoose.Schema({
  channelId: {
    type: String,
    required: true,
    unique: true
  },
  channelName: {
    type: String,
    required: true
  },
  points: {
    type: Number,
    default: 0
  },
  watchTime: {
    type: Number,
    default: 0 // in minutes
  },
  lastActive: {
    type: Date,
    default: Date.now
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Ensure channelId is unique
channelSchema.index({ channelId: 1 }, { unique: true });

module.exports = mongoose.model('Channel', channelSchema); 