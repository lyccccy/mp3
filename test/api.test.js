const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { once } = require('node:events');
const { spawn, spawnSync } = require('node:child_process');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const app = require('../app');
const User = require('../models/user');
const Task = require('../models/task');

let database;
let server;
let base;
const deadline = '2026-12-01T12:00:00.000Z';
const absentId = '0123456789abcdef01234567';

before(async () => {
    database = await MongoMemoryReplSet.create({
        binary: { downloadDir: path.resolve(__dirname, '../node_modules/.cache/mongodb-binaries') },
        replSet: { count: 1, storageEngine: 'wiredTiger' }
    });
    await mongoose.connect(database.getUri(), { dbName: 'mp3-test' });
    await User.init();
    await Task.init();
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}/api`;
}, { timeout: 180000 });

after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await mongoose.disconnect();
    if (database) await database.stop();
});

beforeEach(async () => {
    await Task.deleteMany({});
    await User.deleteMany({});
});

async function request(method, resource, body, status = method === 'DELETE' ? 204 : 200) {
    const response = await fetch(`${base}${resource}`, {
        method,
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    if (status === 204) {
        assert.equal(response.status, 204, `${method} ${resource}`);
        assert.equal(await response.text(), '', 'A 204 response must not contain a body.');
        return null;
    }
    const payload = await response.json();
    assert.equal(response.status, status, `${method} ${resource}: ${JSON.stringify(payload)}`);
    assert.deepEqual(Object.keys(payload).sort(), ['data', 'message']);
    assert.equal(typeof payload.message, 'string');
    assert.ok(payload.message.length);
    return payload.data;
}

const createUser = (name = 'Alice', extra = {}) => request('POST', '/users', {
    name, email: `${name.toLowerCase()}@example.com`, ...extra
}, 201);
const createTask = (name = 'Write report', extra = {}) => request('POST', '/tasks', {
    name, deadline, ...extra
}, 201);
const getUser = (id) => request('GET', `/users/${id}`);
const getTask = (id) => request('GET', `/tasks/${id}`);

async function assertConsistent() {
    const users = await request('GET', '/users');
    const tasks = await request('GET', '/tasks?limit=0');
    const usersById = new Map(users.map((user) => [user._id, user]));
    const tasksById = new Map(tasks.map((task) => [task._id, task]));
    for (const user of users) {
        assert.equal(new Set(user.pendingTasks).size, user.pendingTasks.length);
        for (const id of user.pendingTasks) {
            const task = tasksById.get(id);
            assert.ok(task, `Dangling task ${id}`);
            assert.equal(task.completed, false);
            assert.equal(task.assignedUser, user._id);
            assert.equal(task.assignedUserName, user.name);
        }
    }
    for (const task of tasks) {
        if (!task.assignedUser) {
            assert.equal(task.assignedUserName, 'unassigned');
        } else {
            const user = usersById.get(task.assignedUser);
            assert.ok(user, `Dangling user ${task.assignedUser}`);
            assert.equal(task.assignedUserName, user.name);
            assert.equal(user.pendingTasks.includes(task._id), !task.completed);
        }
    }
}

test('creates resources with server dates and all defaults', async () => {
    const user = await createUser('Alice', { dateCreated: '2000-01-01', _id: absentId });
    assert.deepEqual(user.pendingTasks, []);
    assert.notEqual(user._id, absentId);
    assert.ok(Date.now() - Date.parse(user.dateCreated) < 10000);
    const task = await createTask('Write report', { dateCreated: '2000-01-01' });
    assert.equal(task.description, '');
    assert.equal(task.deadline, deadline);
    assert.equal(task.completed, false);
    assert.equal(task.assignedUser, '');
    assert.equal(task.assignedUserName, 'unassigned');
    assert.ok(Date.now() - Date.parse(task.dateCreated) < 10000);
    assert.equal((await getUser(user._id)).__v, undefined);
});

test('rejects missing, empty, invalid, and incorrectly typed user fields', async () => {
    for (const body of [
        {}, { name: 'Alice' }, { email: 'a@example.com' },
        { name: '', email: 'a@example.com' }, { name: [], email: 'a@example.com' },
        { name: 'Alice', email: false }, { name: 'Alice', email: 'invalid' },
        { name: 'Alice', email: 'a@example.com', pendingTasks: null },
        { name: 'Alice', email: 'a@example.com', pendingTasks: [123] },
        { name: 'Alice', email: 'a@example.com', pendingTasks: ['bad-id'] }
    ]) await request('POST', '/users', body, 400);
    assert.equal(await User.countDocuments(), 0);
});

test('rejects missing, invalid, and incorrectly typed task fields', async () => {
    for (const body of [
        {}, { name: 'Task' }, { deadline }, { name: 3, deadline },
        { name: 'Task', deadline: null }, { name: 'Task', deadline: true },
        { name: 'Task', deadline: 'not-a-date' }, { name: 'Task', deadline: {} },
        { name: 'Task', deadline, completed: 'false' },
        { name: 'Task', deadline, description: [] },
        { name: 'Task', deadline, assignedUser: 'not-an-id' },
        { name: 'Task', deadline, assignedUser: null },
        { name: 'Task', deadline, assignedUserName: 2 },
        { name: 'Task', deadline, assignedUserName: 'Alice' }
    ]) await request('POST', '/tasks', body, 400);
    assert.equal(await Task.countDocuments(), 0);
});

test('enforces unique email on create and replace, including concurrent creates', async () => {
    const alice = await createUser();
    await request('POST', '/users', { name: 'Other', email: alice.email }, 400);
    const bob = await createUser('Bob');
    await request('PUT', `/users/${bob._id}`, { name: 'Other', email: alice.email }, 400);
    assert.deepEqual(await getUser(bob._id), bob);
    await request('PUT', `/users/${alice._id}`, { name: 'Alice', email: alice.email });
    const responses = await Promise.all([1, 2].map(() => fetch(`${base}/users`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Duplicate', email: 'same@example.com' })
    })));
    assert.deepEqual(responses.map((response) => response.status).sort(), [201, 400]);
    assert.equal(await User.countDocuments({ email: 'same@example.com' }), 1);
});

test('URL ids return 404 before invalid fields; valid missing references return 404', async () => {
    for (const endpoint of ['users', 'tasks']) {
        for (const id of ['bad-id', absentId]) {
            await request('GET', `/${endpoint}/${id}`, undefined, 404);
            await request('PUT', `/${endpoint}/${id}`, {}, 404);
            await request('DELETE', `/${endpoint}/${id}`, undefined, 404);
        }
    }
    await request('POST', '/users', { name: 'Alice', email: 'a@example.com', pendingTasks: [absentId] }, 404);
    await request('POST', '/tasks', { name: 'Task', deadline, assignedUser: absentId }, 404);
    assert.equal(await User.countDocuments(), 0);
    assert.equal(await Task.countDocuments(), 0);
    assert.deepEqual(await request('GET', `/users?where=${encodeURIComponent(JSON.stringify({ _id: absentId }))}`), []);
    assert.equal(await request('GET', '/tasks?count=true'), 0);
});

test('assigns on task creation and rejects mismatched user names without side effects', async () => {
    const alice = await createUser();
    const task = await createTask('Pending', { assignedUser: alice._id.toUpperCase() });
    assert.equal(task.assignedUserName, alice.name);
    assert.deepEqual((await getUser(alice._id)).pendingTasks, [task._id]);
    await request('POST', '/tasks', { name: 'Wrong', deadline, assignedUser: alice._id, assignedUserName: 'Bob' }, 400);
    await request('PUT', `/tasks/${task._id}`, { name: 'Wrong', deadline, assignedUser: alice._id, assignedUserName: 'Bob' }, 400);
    assert.deepEqual(await getTask(task._id), task);
    assert.equal(await Task.countDocuments(), 1);
    await assertConsistent();
});

test('task replacement handles transfer, completion, reopening, and unassignment', async () => {
    const alice = await createUser();
    const bob = await createUser('Bob');
    const task = await createTask('Pending', { assignedUser: alice._id, description: 'Original' });
    const url = `/tasks/${task._id}`;
    const moved = await request('PUT', url, { name: 'Moved', deadline, assignedUser: bob._id, dateCreated: '2000-01-01' });
    assert.equal(moved.description, '');
    assert.equal(moved.dateCreated, task.dateCreated);
    assert.deepEqual((await getUser(alice._id)).pendingTasks, []);
    assert.deepEqual((await getUser(bob._id)).pendingTasks, [task._id]);
    await request('PUT', url, { name: 'Done', deadline, completed: true, assignedUser: bob._id });
    assert.equal((await getTask(task._id)).assignedUser, bob._id);
    assert.deepEqual((await getUser(bob._id)).pendingTasks, []);
    await request('PUT', url, { name: 'Done moved', deadline, completed: true, assignedUser: alice._id });
    assert.deepEqual((await getUser(alice._id)).pendingTasks, []);
    await request('PUT', url, { name: 'Reopened', deadline, assignedUser: alice._id });
    assert.deepEqual((await getUser(alice._id)).pendingTasks, [task._id]);
    const reset = await request('PUT', url, { name: 'Reset', deadline });
    assert.equal(reset.completed, false);
    assert.equal(reset.assignedUser, '');
    assert.equal(reset.assignedUserName, 'unassigned');
    await assertConsistent();
});

test('user creation can claim and move pending tasks, deduplicating ids', async () => {
    const alice = await createUser();
    const unassigned = await createTask('Unassigned');
    const assigned = await createTask('Assigned', { assignedUser: alice._id });
    const bob = await createUser('Bob', { pendingTasks: [unassigned._id, assigned._id, assigned._id.toUpperCase()] });
    assert.deepEqual(bob.pendingTasks, [unassigned._id, assigned._id]);
    assert.deepEqual((await getUser(alice._id)).pendingTasks, []);
    assert.equal((await getTask(assigned._id)).assignedUser, bob._id);
    await assertConsistent();
});

test('user replacement releases removed tasks, claims new ones, and renames completed assignments', async () => {
    const alice = await createUser();
    const bob = await createUser('Bob');
    const removed = await createTask('Removed', { assignedUser: alice._id });
    const kept = await createTask('Kept', { assignedUser: alice._id });
    const done = await createTask('Done', { assignedUser: alice._id, completed: true });
    const moved = await createTask('Moved', { assignedUser: bob._id });
    const user = await request('PUT', `/users/${alice._id}`, {
        name: 'Alicia', email: alice.email, pendingTasks: [kept._id, moved._id], dateCreated: '2000-01-01'
    });
    assert.equal(user.dateCreated, alice.dateCreated);
    assert.equal((await getTask(removed._id)).assignedUser, '');
    assert.equal((await getTask(done._id)).assignedUserName, 'Alicia');
    assert.deepEqual((await getUser(bob._id)).pendingTasks, []);
    await assertConsistent();
    const replaced = await request('PUT', `/users/${alice._id}`, { name: 'Alice again', email: alice.email });
    assert.deepEqual(replaced.pendingTasks, []);
    assert.equal((await getTask(kept._id)).assignedUser, '');
    assert.equal((await getTask(moved._id)).assignedUser, '');
    assert.equal((await getTask(done._id)).assignedUser, alice._id);
    assert.equal((await getTask(done._id)).assignedUserName, 'Alice again');
    await assertConsistent();
});

test('rejects completed pendingTasks and invalid replacements without modifying existing data', async () => {
    const alice = await createUser();
    const pending = await createTask('Pending', { assignedUser: alice._id });
    const done = await createTask('Done', { assignedUser: alice._id, completed: true });
    await request('POST', '/users', { name: 'Bob', email: 'bob@example.com', pendingTasks: [done._id] }, 400);
    await request('PUT', `/users/${alice._id}`, { name: 'Changed', email: alice.email, pendingTasks: [done._id] }, 400);
    await request('PUT', `/users/${alice._id}`, { name: 'Changed', email: alice.email, pendingTasks: [absentId] }, 404);
    await request('PUT', `/users/${alice._id}`, { name: 'Changed' }, 400);
    await request('PUT', `/tasks/${pending._id}`, { name: 'Changed' }, 400);
    await request('PUT', `/tasks/${pending._id}`, { name: 'Changed', deadline, assignedUser: absentId }, 404);
    assert.equal((await getUser(alice._id)).name, 'Alice');
    assert.deepEqual(await getTask(pending._id), pending);
    assert.equal(await User.countDocuments(), 1);
    await assertConsistent();
});

test('combines filtering, sorting, projection, skip and limit in database queries', async () => {
    const tasks = await Task.insertMany(['C', 'B', 'A', 'D'].map((name, index) => ({
        name, deadline, completed: index === 3
    })));
    const query = new URLSearchParams({
        where: JSON.stringify({ completed: false }), sort: JSON.stringify({ name: 1 }),
        select: JSON.stringify({ name: 1, _id: 0 }), skip: '1', limit: '1'
    });
    assert.deepEqual(await request('GET', `/tasks?${query}`), [{ name: 'B' }]);
    query.set('count', 'true');
    assert.equal(await request('GET', `/tasks?${query}`), 3);
    const filter = { _id: { $in: [tasks[0]._id.toString(), tasks[2]._id.toString()] } };
    assert.equal((await request('GET', `/tasks?where=${encodeURIComponent(JSON.stringify(filter))}`)).length, 2);
    const nested = { $and: [{ completed: false }, { name: { $in: ['A', 'C'] } }] };
    assert.equal(await request('GET', `/tasks?count=true&where=${encodeURIComponent(JSON.stringify(nested))}`), 2);
    assert.deepEqual(await request('GET', `/tasks?where=${encodeURIComponent('{"name":"Absent"}')}`), []);
});

test('defaults to 100 tasks, unlimited users; limit zero returns all tasks', async () => {
    await Task.insertMany(Array.from({ length: 105 }, (_, index) => ({ name: `Task ${index}`, deadline })));
    await User.insertMany(Array.from({ length: 105 }, (_, index) => ({ name: `User ${index}`, email: `user${index}@example.com` })));
    assert.equal((await request('GET', '/tasks')).length, 100);
    assert.equal((await request('GET', '/tasks?limit=0')).length, 105);
    assert.equal((await request('GET', '/users')).length, 105);
    assert.equal((await request('GET', '/users?limit=5&skip=100')).length, 5);
    assert.equal(await request('GET', '/tasks?count=true&skip=100&limit=1'), 105);
});

test('select works on both single resources and unrelated query parameters are ignored', async () => {
    const alice = await createUser();
    const task = await createTask();
    for (const [endpoint, resource] of [['users', alice], ['tasks', task]]) {
        const query = new URLSearchParams({ select: '{"name":1,"_id":0}', where: 'invalid-json', count: 'invalid-json', sort: 'invalid-json', skip: '-1', limit: 'null' });
        assert.deepEqual(await request('GET', `/${endpoint}/${resource._id}?${query}`), { name: resource.name });
        const excluded = await request('GET', `/${endpoint}/${resource._id}?select=${encodeURIComponent('{"_id":0}')}`);
        assert.equal(excluded._id, undefined);
        assert.equal(excluded.name, resource.name);
        await request('GET', `/${endpoint}/${resource._id}?select=oops`, undefined, 400);
    }
});

test('invalid JSON and query shapes return 400 with a safe error envelope', async () => {
    for (const query of [
        'where=oops', 'where=null', 'where=[]', 'sort=oops', 'select=oops', 'count=oops',
        'skip=oops', 'limit=oops', 'skip=-1', 'limit=1.5', 'count=1', 'sort={"name":0}',
        'select={"name":"$email"}', 'select={"name":1,"email":0}',
        'where={"$where":"true"}', 'where={"_id":"bad-id"}',
        'limit=2&limit=3', 'where={"name":{"$unknown":1}}'
    ]) await request('GET', `/tasks?${encodeURI(query)}`, undefined, 400);
    const response = await fetch(`${base}/users`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{invalid'
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { message: 'The request body must contain valid JSON.', data: null });
});

test('deleting tasks and users cleans pending and completed references', async () => {
    const alice = await createUser();
    const pending = await createTask('Pending', { assignedUser: alice._id });
    const done = await createTask('Done', { assignedUser: alice._id, completed: true });
    await request('DELETE', `/tasks/${pending._id}`);
    assert.deepEqual((await getUser(alice._id)).pendingTasks, []);
    await request('GET', `/tasks/${pending._id}`, undefined, 404);
    const other = await createTask('Other', { assignedUser: alice._id });
    await request('DELETE', `/users/${alice._id}`);
    await request('GET', `/users/${alice._id}`, undefined, 404);
    for (const id of [done._id, other._id]) {
        const task = await getTask(id);
        assert.equal(task.assignedUser, '');
        assert.equal(task.assignedUserName, 'unassigned');
    }
    assert.equal((await getTask(done._id)).completed, true);
    await assertConsistent();
});

test('an unexpected mid-write database error rolls back the transaction and hides internals', async () => {
    const alice = await createUser();
    const task = await createTask('Pending', { assignedUser: alice._id });
    const beforeUpdate = await getUser(alice._id);
    const original = Task.updateMany;
    Task.updateMany = () => { throw new Error('private database internals'); };
    try {
        const response = await fetch(`${base}/users/${alice._id}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Changed', email: alice.email })
        });
        assert.equal(response.status, 500);
        const payload = await response.json();
        assert.equal(payload.data, null);
        assert.doesNotMatch(JSON.stringify(payload), /private|mongoose|mongo/i);
    } finally {
        Task.updateMany = original;
    }
    assert.deepEqual(await getUser(alice._id), beforeUpdate);
    assert.deepEqual(await getTask(task._id), task);
    await assertConsistent();
});

test('concurrent transfers keep each pending task assigned to exactly one user', async () => {
    const alice = await createUser();
    const bob = await createUser('Bob');
    const task = await createTask('Concurrent', { assignedUser: alice._id });
    await Promise.all(Array.from({ length: 8 }, (_, index) => request('PUT', `/tasks/${task._id}`, {
        name: `Revision ${index}`, deadline, assignedUser: index % 2 ? alice._id : bob._id
    })));
    await assertConsistent();
});

test('concurrent user renames and completed task creation keep names synchronized', async () => {
    const alice = await createUser();
    await Promise.all([
        request('PUT', `/users/${alice._id}`, { name: 'Alicia', email: alice.email }),
        ...Array.from({ length: 6 }, (_, index) => createTask(`Completed ${index}`, { assignedUser: alice._id, completed: true }))
    ]);
    await assertConsistent();
});

test('accepts form requests, provides CORS preflight and returns JSON for unknown routes', async () => {
    const response = await fetch(`${base}/users`, {
        method: 'POST', body: new URLSearchParams({ name: 'Form user', email: 'form@example.com', pendingTasks: '[]' })
    });
    assert.equal(response.status, 201);
    const user = (await response.json()).data;
    const taskResponse = await fetch(`${base}/tasks`, {
        method: 'POST', body: new URLSearchParams({ name: 'Form task', deadline, completed: 'false', assignedUser: user._id })
    });
    assert.equal(taskResponse.status, 201);
    assert.equal((await taskResponse.json()).data.completed, false);
    const options = await fetch(`${base}/tasks`, { method: 'OPTIONS' });
    assert.equal(options.status, 204);
    assert.equal(options.headers.get('access-control-allow-origin'), '*');
    assert.equal(await options.text(), '');
    await request('GET', '/missing', undefined, 404);
    await request('GET', '/');
    await assertConsistent();
});

test('production entry point connects before listening and fails clearly without configuration', async () => {
    const missing = spawnSync(process.execPath, ['server.js'], {
        cwd: path.resolve(__dirname, '..'), encoding: 'utf8',
        env: { ...process.env, MONGODB_URI: '' }
    });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /Set MONGODB_URI in .env/);

    const child = spawn(process.execPath, ['server.js'], {
        cwd: path.resolve(__dirname, '..'),
        env: { ...process.env, MONGODB_URI: database.getUri('mp3-startup-test'), PORT: '0' },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let errors = '';
    child.stderr.on('data', (data) => { errors += data; });
    try {
        const [output] = await once(child.stdout, 'data', { signal: AbortSignal.timeout(10000) });
        const match = output.toString().match(/API listening on port (\d+)/);
        assert.ok(match, errors);
        const response = await fetch(`http://127.0.0.1:${match[1]}/api/users`);
        assert.equal(response.status, 200);
        assert.deepEqual((await response.json()).data, []);
    } finally {
        const stopped = once(child, 'exit');
        child.kill('SIGTERM');
        const [code] = await stopped;
        assert.equal(code, 0, errors);
    }
});
