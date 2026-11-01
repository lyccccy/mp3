const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, trim: true },
    pendingTasks: { type: [String], default: [] },
    dateCreated: { type: Date, default: Date.now, immutable: true },
    __v: { type: Number, default: 0, select: false }
}, {
    optimisticConcurrency: true,
    toObject: { transform: (doc, value) => { delete value.__v; return value; } },
    toJSON: { transform: (doc, value) => { delete value.__v; return value; } }
});

module.exports = mongoose.model('User', userSchema);
