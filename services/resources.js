const mongoose = require('mongoose');
const User = require('../models/user');
const Task = require('../models/task');
const { ApiError } = require('../lib/errors');
const { validId, userInput, taskInput } = require('../lib/validation');

async function findResource(Model, id, session) {
    if (!validId(id)) throw new ApiError(404, `${Model.modelName} not found.`);
    const query = Model.findById(id).session(session || null);
    if (Model === User) query.select('+__v');
    const resource = await query;
    if (!resource) throw new ApiError(404, `${Model.modelName} not found.`);
    return resource;
}

async function writeUser(id, body) {
    return mongoose.connection.transaction(async (session) => {
        const user = id === undefined ? new User() : await findResource(User, id, session);
        const values = userInput(body);
        const duplicate = await User.exists({ email: values.email, _id: { $ne: user._id } }).session(session);
        if (duplicate) throw new ApiError(400, 'That email address is already in use.');
        const tasks = await Task.find({ _id: { $in: values.pendingTasks } }).session(session);
        if (tasks.some((task) => task.completed)) throw new ApiError(400, 'pendingTasks cannot contain completed tasks.');
        if (tasks.length !== values.pendingTasks.length) throw new ApiError(404, 'One or more pending tasks do not exist.');

        const userId = user._id.toString();
        const removed = user.pendingTasks.filter((taskId) => !values.pendingTasks.includes(taskId));
        user.set(values);
        user.increment();
        await user.save({ session });
        await Task.updateMany({ _id: { $in: removed }, assignedUser: userId }, {
            $set: { assignedUser: '', assignedUserName: 'unassigned' }
        }, { session });
        await User.updateMany({ _id: { $ne: user._id }, pendingTasks: { $in: values.pendingTasks } }, {
            $pull: { pendingTasks: { $in: values.pendingTasks } }, $inc: { __v: 1 }
        }, { session });
        await Task.updateMany({ _id: { $in: values.pendingTasks } }, {
            $set: { assignedUser: userId, assignedUserName: user.name }
        }, { session });
        await Task.updateMany({ assignedUser: userId }, {
            $set: { assignedUserName: user.name }
        }, { session });
        return user.toObject();
    });
}

async function writeTask(id, body) {
    return mongoose.connection.transaction(async (session) => {
        const task = id === undefined ? new Task() : await findResource(Task, id, session);
        const values = taskInput(body);
        let user = null;
        if (values.assignedUser) {
            user = await User.findById(values.assignedUser).session(session);
            if (!user) throw new ApiError(404, 'Assigned user not found.');
            if (values.assignedUserName !== undefined && values.assignedUserName !== user.name) {
                throw new ApiError(400, 'assignedUserName must match the assigned user’s name.');
            }
        }
        values.assignedUserName = user ? user.name : 'unassigned';
        const previousUser = task.assignedUser;
        task.set(values);
        await task.save({ session });
        const taskId = task._id.toString();
        if (previousUser && previousUser !== values.assignedUser) {
            await User.updateOne({ _id: previousUser }, { $pull: { pendingTasks: taskId }, $inc: { __v: 1 } }, { session });
        }
        if (user) {
            const update = task.completed ? { $pull: { pendingTasks: taskId } } : { $addToSet: { pendingTasks: taskId } };
            update.$inc = { __v: 1 };
            await User.updateOne({ _id: user._id }, update, { session });
        }
        return task.toObject();
    });
}

async function deleteResource(Model, id) {
    return mongoose.connection.transaction(async (session) => {
        const resource = await findResource(Model, id, session);
        if (Model === User) {
            await Task.updateMany({ assignedUser: resource._id.toString() }, {
                $set: { assignedUser: '', assignedUserName: 'unassigned' }
            }, { session });
        } else {
            await User.updateMany({ pendingTasks: resource._id.toString() }, {
                $pull: { pendingTasks: resource._id.toString() }, $inc: { __v: 1 }
            }, { session });
        }
        await resource.deleteOne({ session });
    });
}

module.exports = { findResource, writeUser, writeTask, deleteResource };
