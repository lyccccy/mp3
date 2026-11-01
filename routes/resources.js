const User = require('../models/user');
const Task = require('../models/task');
const { collectionQuery, selection } = require('../lib/query');
const { normalizeForm } = require('../lib/validation');
const { ApiError } = require('../lib/errors');
const { findResource, writeUser, writeTask, deleteResource } = require('../services/resources');

module.exports = function (router) {
    for (const [path, Model, write, defaultLimit] of [
        ['users', User, writeUser, 0],
        ['tasks', Task, writeTask, 100]
    ]) {
        router.get(`/${path}`, async (req, res) => {
            const { where, sort, select, skip, limit, count } = collectionQuery(req.query, defaultLimit);
            const data = count
                ? await Model.countDocuments(where)
                : await Model.find(where).sort(sort).select(select).skip(skip).limit(limit).lean();
            res.json({ message: 'OK', data });
        });
        router.post(`/${path}`, normalizeForm, async (req, res) => {
            const data = await write(undefined, req.body);
            res.status(201).json({ message: `${Model.modelName} created.`, data });
        });
        router.get(`/${path}/:id`, async (req, res) => {
            await findResource(Model, req.params.id);
            const data = await Model.findById(req.params.id).select(selection(req.query)).lean();
            if (!data) throw new ApiError(404, `${Model.modelName} not found.`);
            res.json({ message: 'OK', data });
        });
        router.put(`/${path}/:id`, async (req, res, next) => {
            await findResource(Model, req.params.id);
            next();
        }, normalizeForm, async (req, res) => {
            const data = await write(req.params.id, req.body);
            res.json({ message: `${Model.modelName} updated.`, data });
        });
        router.delete(`/${path}/:id`, async (req, res) => {
            await deleteResource(Model, req.params.id);
            res.status(204).end();
        });
    }
};
