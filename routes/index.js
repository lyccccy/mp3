module.exports = function (app, router) {
    require('./home')(router);
    require('./resources')(router);
    app.use('/api', router);
};
