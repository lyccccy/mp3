const { ApiError } = require('./errors');

const validId = (value) => typeof value === 'string' && /^[a-f\d]{24}$/i.test(value);

function fail(message) {
    throw new ApiError(400, message);
}

function bodyObject(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        fail('Provide a JSON object containing the resource fields.');
    }
}

function requiredString(value, field) {
    if (typeof value !== 'string' || !value.trim()) fail(`${field} must be a nonempty string.`);
    return value.trim();
}

function userInput(body) {
    bodyObject(body);
    const name = requiredString(body.name, 'name');
    const email = requiredString(body.email, 'email');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('email must be a valid email address.');
    const pendingTasks = body.pendingTasks === undefined ? [] : body.pendingTasks;
    if (!Array.isArray(pendingTasks) || pendingTasks.some((id) => !validId(id))) {
        fail('pendingTasks must be an array of valid task ids.');
    }
    return { name, email, pendingTasks: [...new Set(pendingTasks.map((id) => id.toLowerCase()))] };
}

function taskInput(body) {
    bodyObject(body);
    const name = requiredString(body.name, 'name');
    if (!['string', 'number'].includes(typeof body.deadline)
        || (typeof body.deadline === 'string' && !body.deadline.trim())
        || !Number.isFinite(new Date(body.deadline).getTime())) {
        fail('deadline must be a valid date string or timestamp.');
    }
    const description = body.description === undefined ? '' : body.description;
    const completed = body.completed === undefined ? false : body.completed;
    const assignedUser = body.assignedUser === undefined ? '' : body.assignedUser;
    if (typeof description !== 'string') fail('description must be a string.');
    if (typeof completed !== 'boolean') fail('completed must be a boolean.');
    if (assignedUser !== '' && !validId(assignedUser)) fail('assignedUser must be empty or a valid user id.');
    if (body.assignedUserName !== undefined && typeof body.assignedUserName !== 'string') {
        fail('assignedUserName must be a string.');
    }
    if (assignedUser === '' && body.assignedUserName !== undefined && body.assignedUserName !== 'unassigned') {
        fail('An unassigned task must have assignedUserName set to "unassigned".');
    }
    return {
        name, description, deadline: new Date(body.deadline), completed,
        assignedUser: assignedUser.toLowerCase(), assignedUserName: body.assignedUserName
    };
}

function normalizeForm(req, res, next) {
    if (req.is('application/x-www-form-urlencoded') && req.body) {
        for (const field of ['pendingTasks', 'completed']) {
            if (typeof req.body[field] === 'string') {
                try {
                    req.body[field] = JSON.parse(req.body[field]);
                } catch {
                    fail(`${field} must be JSON encoded in a form request.`);
                }
            }
        }
    }
    next();
}

module.exports = { validId, userInput, taskInput, normalizeForm };
