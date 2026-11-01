const { ApiError } = require('./errors');

function parse(query, key, fallback) {
    if (query[key] === undefined) return fallback;
    if (typeof query[key] !== 'string') throw new ApiError(400, `${key} must be supplied once as JSON.`);
    try {
        return JSON.parse(query[key]);
    } catch {
        throw new ApiError(400, `${key} must contain valid JSON.`);
    }
}

function object(value, key) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new ApiError(400, `${key} must be a JSON object.`);
    }
    return value;
}

function safeFilter(value) {
    if (!value || typeof value !== 'object') return;
    for (const [key, nested] of Object.entries(value)) {
        if (['$where', '$function', '$accumulator', '__proto__', 'constructor', 'prototype'].includes(key)) {
            throw new ApiError(400, 'The filter contains an unsupported operator.');
        }
        safeFilter(nested);
    }
}

function selection(query) {
    const select = object(parse(query, 'select', {}), 'select');
    let includes = false;
    let excludes = false;
    for (const [field, direction] of Object.entries(select)) {
        if (!field || field.startsWith('$') || ![0, 1].includes(direction)) {
            throw new ApiError(400, 'select values must be 1 (include) or 0 (exclude).');
        }
        if (field !== '_id') {
            includes ||= direction === 1;
            excludes ||= direction === 0;
        }
    }
    if (includes && excludes) throw new ApiError(400, 'select cannot mix inclusion and exclusion except for _id.');
    return select;
}

function collectionQuery(query, defaultLimit) {
    const where = object(parse(query, 'where', {}), 'where');
    safeFilter(where);
    const sort = object(parse(query, 'sort', {}), 'sort');
    for (const [field, direction] of Object.entries(sort)) {
        if (!field || field.startsWith('$') || ![1, -1].includes(direction)) {
            throw new ApiError(400, 'sort values must be 1 (ascending) or -1 (descending).');
        }
    }
    const select = selection(query);
    const skip = parse(query, 'skip', 0);
    const limit = parse(query, 'limit', defaultLimit);
    for (const [key, value] of Object.entries({ skip, limit })) {
        if (!Number.isSafeInteger(value) || value < 0) throw new ApiError(400, `${key} must be a nonnegative integer.`);
    }
    const count = parse(query, 'count', false);
    if (typeof count !== 'boolean') throw new ApiError(400, 'count must be true or false.');
    return { where, sort, select, skip, limit, count };
}

module.exports = { selection, collectionQuery };
