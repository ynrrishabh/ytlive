const mongoose = require('mongoose');

const viewerSchema = new mongoose.Schema({
  channelId: {
    type: String,
    required: true
  },
  viewerId: {
    type: String,
    required: true
  },
  username: {
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

// Keep only this compound index
viewerSchema.index({ channelId: 1, viewerId: 1 }, { unique: true });

module.exports = mongoose.model('Viewer', viewerSchema); 