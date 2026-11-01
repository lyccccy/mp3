require('dotenv').config({ quiet: true });

const mongoose = require('mongoose');
const app = require('./app');
const User = require('./models/user');
const Task = require('./models/task');

async function start() {
    if (!process.env.MONGODB_URI) {
        throw new Error('Set MONGODB_URI in .env before starting the server.');
    }
    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
    await User.init();
    await Task.init();
    const server = app.listen(process.env.PORT || 3000, () => {
        console.log(`API listening on port ${server.address().port}`);
    });
    async function shutdown() {
        server.close(async () => {
            await mongoose.disconnect();
            process.exit(0);
        });
    }
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    return server;
}

if (require.main === module) {
    start().catch(async (error) => {
        console.error(process.env.MONGODB_URI
            ? 'Could not start the API. Check the database connection and access settings.'
            : error.message);
        await mongoose.disconnect();
        process.exitCode = 1;
    });
}

module.exports = start;
