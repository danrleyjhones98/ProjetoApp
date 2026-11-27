const APP_ORIGIN = "https://danrleyjhones98.github.io";
const DATA_PATH = "data/conferencia.json";

function jsonResponse(body, status, origin) {
return new Response(JSON.stringify(body), {
status,
headers: {
"Content-Type": "application/json; charset=utf-8",
"Cache-Control": "no-store",
"Access-Control-Allow-Origin": origin,
"Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
"Access-Control-Allow-Headers": "Authorization, Content-Type",
"Vary": "Origin"
}
});
}

function constantTimeEqual(left, right) {
if (typeof left !== "string" || typeof right !== "string") return false;
let difference = left.length ^ right.length;
const length = Math.max(left.length, right.length);
for (let index = 0; index < length; index += 1) {
difference |= (left.charCodeAt(index % left.length) || 0) ^
(right.charCodeAt(index % right.length) || 0);
}
return difference === 0;
}

function decodeBase64Utf8(value) {
const binary = atob(value.replace(/\s/g, ""));
const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
return new TextDecoder().decode(bytes);
}

function encodeBase64Utf8(value) {
const bytes = new TextEncoder().encode(value);
let binary = "";
for (let offset = 0; offset < bytes.length; offset += 8192) {
binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
}
return btoa(binary);
}

async function githubRequest(env, path, options = {}) {
return fetch(`https://api.github.com/repos/${env.DATA_REPO_OWNER}/${env.DATA_REPO_NAME}/contents/${path}`, {
...options,
headers: {
Accept: "application/vnd.github+json",
Authorization: `Bearer ${env.GITHUB_TOKEN}`,
"X-GitHub-Api-Version": "2022-11-28",
"Content-Type": "application/json",
...(options.headers || {})
}
});
}

async function getDataFile(env) {
const response = await githubRequest(env, DATA_PATH);
if (response.status === 404) return null;
if (!response.ok) throw new Error(`GitHub retornou HTTP ${response.status} ao ler os dados.`);
const file = await response.json();
if (typeof file.content !== "string" || typeof file.sha !== "string") {
throw new Error("O arquivo privado de dados tem um formato inválido.");
}
return {
state: JSON.parse(decodeBase64Utf8(file.content)),
revision: file.sha
};
}

async function handlePut(request, env, origin) {
const contentLength = Number(request.headers.get("Content-Length") || 0);
if (contentLength > 1_500_000) {
return jsonResponse({ error: "O arquivo de dados excede o limite permitido." }, 413, origin);
}
const requestBody = await request.text();
if (new TextEncoder().encode(requestBody).length > 1_500_000) {
return jsonResponse({ error: "O arquivo de dados excede o limite permitido." }, 413, origin);
}
let payload;
try {
payload = JSON.parse(requestBody);
} catch {
return jsonResponse({ error: "O corpo da solicitação não contém JSON válido." }, 400, origin);
}
if (!payload || !payload.state || typeof payload.state !== "object" ||
!Array.isArray(payload.state.registros) ||
(payload.expectedRevision !== null && typeof payload.expectedRevision !== "string")) {
return jsonResponse({ error: "O estado ou a revisão enviados são inválidos." }, 400, origin);
}

const serialized = JSON.stringify(payload.state);
if (new TextEncoder().encode(serialized).length > 1_500_000) {
return jsonResponse({ error: "O arquivo de dados excede o limite permitido." }, 413, origin);
}

const current = await getDataFile(env);
if ((current ? current.revision : null) !== payload.expectedRevision) {
return jsonResponse({
error: "Os dados mudaram na nuvem. Baixe a versão mais recente ou escolha substituir a nuvem."
}, 409, origin);
}

const response = await githubRequest(env, DATA_PATH, {
method: "PUT",
body: JSON.stringify({
message: "Atualizar dados privados do ProjetoApp",
content: encodeBase64Utf8(serialized),
...(current ? { sha: current.revision } : {}),
branch: "main"
})
});
if (response.status === 409 || response.status === 422) {
return jsonResponse({
error: "Os dados mudaram durante o envio. Sincronize novamente para evitar sobrescrever alterações."
}, 409, origin);
}
if (!response.ok) {
const detail = await response.text();
console.error("Falha ao gravar no GitHub:", response.status, detail);
return jsonResponse({ error: `Não foi possível gravar no repositório privado (HTTP ${response.status}).` }, 502, origin);
}

const result = await response.json();
if (typeof result.content?.sha !== "string") {
return jsonResponse({ error: "O GitHub não confirmou a revisão gravada." }, 502, origin);
}
return jsonResponse({ revision: result.content.sha }, 200, origin);
}

export default {
async fetch(request, env) {
const origin = request.headers.get("Origin");
if (origin !== APP_ORIGIN) {
return new Response("Origem não autorizada.", { status: 403 });
}
if (request.method === "OPTIONS") {
return new Response(null, {
status: 204,
headers: {
"Access-Control-Allow-Origin": APP_ORIGIN,
"Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
"Access-Control-Allow-Headers": "Authorization, Content-Type",
"Access-Control-Max-Age": "86400",
"Vary": "Origin"
}
});
}

const url = new URL(request.url);
if (url.pathname !== "/data") return jsonResponse({ error: "Rota não encontrada." }, 404, origin);
const authorization = request.headers.get("Authorization") || "";
const providedKey = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
if (!constantTimeEqual(providedKey, env.APP_ACCESS_KEY)) {
return jsonResponse({ error: "Chave de acesso inválida." }, 401, origin);
}

try {
if (request.method === "GET") {
const current = await getDataFile(env);
return jsonResponse(current || { state: null, revision: null }, 200, origin);
}
if (request.method === "PUT") return await handlePut(request, env, origin);
return jsonResponse({ error: "Método não permitido." }, 405, origin);
} catch (error) {
console.error("Erro no serviço de sincronização:", error);
return jsonResponse({ error: "Falha ao acessar o armazenamento privado. Tente novamente." }, 502, origin);
}
}
};
