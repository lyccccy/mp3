# Running the completed API

Use Node 24 LTS (also specified in `.nvmrc` and `package.json`):

```sh
nvm install 24
nvm use
npm ci
cp .env.example .env
```

Set `MONGODB_URI` in `.env` to your MongoDB Atlas connection string, including a database name. Then run `npm start` (or `npm run dev` for automatic restarts). The default address is `http://localhost:3000/api`; `PORT` overrides the port. The server connects and initializes indexes before accepting requests. `.env` remains ignored by Git.

The API uses database transactions for all writes. Atlas supports them; a local MongoDB must run as a replica set, rather than a standalone server. No Atlas credentials are necessary to run the tests below.

## Verification

```sh
npm test
```

The tests start a temporary, real MongoDB replica set and send HTTP requests to Express. The first run downloads a MongoDB binary into `node_modules/.cache/mongodb-binaries`, so it requires network access. Later runs use the cached binary. Test data is isolated from `.env` and your Atlas database, and the temporary server and database stop after the tests.

Coverage includes all ten resource endpoints, required fields and types, email uniqueness, default values, immutable server-created dates, two-way task assignments, transfers, completion/reopening, renaming users, deletion cleanup, query combinations, pagination defaults, single-resource projections, error priority, rollback after an injected database failure, and concurrent writes.

## API behavior

- `GET /api/users` and `GET /api/tasks`: Mongoose handles JSON-encoded `where`, `sort`, `select`, `skip`, `limit`, and `count`. Tasks default to 100 results; users have no default limit. An explicit `limit=0` is unlimited. `count=true` returns the number matching `where`, independent of projection, sorting, or pagination.
- `GET /api/users/:id` and `GET /api/tasks/:id`: return one resource or 404; only `select` is interpreted. Other query parameters are ignored.
- `POST`: creates a resource and returns 201. `PUT`: replaces its editable fields, preserves `dateCreated`, and returns 200. Missing optional fields receive their defaults.
- `DELETE`: returns 204 without a body, after cleaning references. CORS `OPTIONS` also returns 204 without a body.
- All other success/error responses contain exactly `message` and `data`. Errors use 400, 404, or 500 with human-readable messages and `data: null`.
- Send JSON with correctly typed fields. URL-encoded forms also work; encode `pendingTasks` as a JSON array and `completed` as `true` or `false`.
- Task ids and user ids in bodies must be 24-character hexadecimal strings. Duplicate pending ids are deduplicated. Referenced resources must exist, and pending tasks must be incomplete. An omitted assigned user name is filled in from the user; an explicit mismatch is rejected.
- All writes, including reference updates, commit or roll back together. Internal user versions make concurrent assignment and rename operations conflict and retry rather than leave stale names or pending lists. These versions are omitted from normal API responses.

Example:

```sh
curl -X POST http://localhost:3000/api/users \
  -H 'Content-Type: application/json' \
  -d '{"name":"Alice","email":"alice@example.com"}'

curl -X POST http://localhost:3000/api/tasks \
  -H 'Content-Type: application/json' \
  -d '{"name":"Finish MP3","deadline":"2026-11-03T23:59:00-06:00"}'

curl --get http://localhost:3000/api/tasks \
  --data-urlencode 'where={"completed":false}' \
  --data-urlencode 'sort={"deadline":1}' \
  --data-urlencode 'select={"name":1,"deadline":1}' \
  --data-urlencode 'limit=20'
```

## Deploying and submitting later

1. The public source repository is [lyccccy/mp3](https://github.com/lyccccy/mp3). The local `origin` points to this repository; the original course template is retained as `upstream`.
2. Configure an Atlas database and its database user. Follow the assignment's network access requirement, and copy the connection URI without committing it.
3. On Render, create a Blueprint from your repository using `render.yaml`. It selects Node 24, installs production dependencies with `npm ci --omit=dev`, starts with `npm start`, and asks for `MONGODB_URI` as a secret. Alternatively create a Node web service with those same settings.
4. The deployed base URL is `https://mp3-api-pfi5.onrender.com`; the API starts at [`/api`](https://mp3-api-pfi5.onrender.com/api). `API_URL` in `submit.js` is configured to this base URL, and `AUTOGRADER_URL` is unchanged. Run `npm run submit` with Node 24 to check the deployment.
5. Submit the repository and deployed URL through the form linked in the assignment README. Include the LLM chat log and answer the LLM-use survey.

Atlas connectivity and local startup have been verified against the `mp3` database. On Render, `GET /api`, `GET /api/users`, and `GET /api/tasks` each returned 200. The course autograder runs against the deployed API; running it does not submit the assignment form.

## References and LLM use

The implementation follows this repository's [README](README.md) and [FAQ](FAQ.md). Documentation consulted:

- [Mongoose transactions](https://mongoosejs.com/docs/transactions.html): transaction rollback/retries and sequential operations within a session.
- [Mongoose Query API](https://mongoosejs.com/docs/api/query.html): database-side queries, projections, and counts.
- [Render Blueprint specification](https://render.com/docs/blueprint-spec): service and secret environment variable configuration.
- [mongodb-memory-server](https://github.com/typegoose/mongodb-memory-server): temporary replica set for integration testing.

OpenAI Codex generated and tested this implementation in response to the request to complete the README requirements. `llm_logs.csv` contains the exported user and assistant text available when it was generated; tool calls, tool output, system instructions, and internal reasoning are excluded. Personal home-directory paths, public client IP addresses, and MongoDB connection strings (including illustrative examples) are redacted. The course requires including chat logs with the source and answering its LLM-use survey. Regenerate the log after any further work using the included exporter.
