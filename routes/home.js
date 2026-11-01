module.exports = function (router) {
    router.get('/', (req, res) => {
        res.json({ message: 'Llama.io task API is ready.', data: { users: '/api/users', tasks: '/api/tasks' } });
    });
    return router;
};
