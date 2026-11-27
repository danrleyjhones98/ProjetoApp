const STORAGE_KEY = "conferencia_madeiras_v1";
const SYNC_CONFIG_KEY = "conferencia_madeiras_sync_config_v1";
const SYNC_METADATA_KEY = "conferencia_madeiras_sync_metadata_v1";
const BOX_MODEL_VALUE_PREFIX = "box-model:";
const BOX_ENTRY_VALUE_PREFIX = "box-entry:";
const LEGACY_TYPE_VALUE_PREFIX = "legacy-type:";
const BOX_NUMBERS = Array.from({ length: 36 }, (_, index) => index + 1);

function createDefaultBoxes() {
return BOX_NUMBERS.map((number) => ({
id: `number-${number}`,
name: `Box ${number}`,
number
}));
}

const DEFAULT_STATE = {
boxes: createDefaultBoxes(),
clientes: [
"Cliente Padrão",
"Construtora Litoral",
"Depósito Central"
],
tipos: [
"Régua",
"Barrote",
"Linha Mista",
"Palete PBR",
"Pallet",
"Tábua"
],
medidas: [
"1,10 x 0,07 x 0,019",
"0,80 x 0,07 x 0,019",
"5,0 x 9,0 x 1,0",
"1,20 x 1,00"
],
registros: [],
movimentacoes: [],
lancamentosFinanceiros: [],
itensEstoque: [],
modelosBox: []
};

let state = loadState();
let syncConfig = loadSyncConfig();
let syncMetadata = loadSyncMetadata();
let manualTotalOverride = false;
let legacyBoxQuantityWithoutPackages = false;
let syncTimer;
let syncInProgress = false;
let applyingRemoteState = false;

function createDefaultState() {
return {
boxes: createDefaultBoxes(),
clientes: [...DEFAULT_STATE.clientes],
tipos: [...DEFAULT_STATE.tipos],
medidas: [...DEFAULT_STATE.medidas],
registros: [],
movimentacoes: [],
lancamentosFinanceiros: [],
itensEstoque: [],
modelosBox: []
};
}

function loadState() {
let raw;
try {
raw = localStorage.getItem(STORAGE_KEY);
} catch (error) {
console.error("Não foi possível ler os dados locais.", error);
showToast("Não foi possível acessar o armazenamento local deste navegador.");
return createDefaultState();
}
if (!raw) return createDefaultState();

try {
return normalizeState(JSON.parse(raw), DEFAULT_STATE);
} catch (error) {
console.error("Os dados locais não puderam ser carregados.", error);
showToast("Os dados locais estão inválidos. Use um backup para restaurá-los.");
return createDefaultState();
}
}

function normalizeState(candidate, fallback) {
if (!candidate || typeof candidate !== "object" || !Array.isArray(candidate.registros)) {
throw new Error("O backup não contém uma lista de registros válida.");
}

const boxes = normalizeBoxes(candidate.boxes);
const listKeys = ["clientes", "tipos", "medidas"];
for (const key of listKeys) {
if (candidate[key] !== undefined &&
(!Array.isArray(candidate[key]) || !candidate[key].every((item) => typeof item === "string"))) {
throw new Error(`A lista "${key}" é inválida.`);
}
}

const validRecords = candidate.registros.every((record) =>
record &&
typeof record === "object" &&
typeof record.id === "string" &&
typeof record.cliente === "string" &&
typeof record.tipoItem === "string" &&
typeof record.medida === "string" &&
(record.modeloBoxId === undefined || typeof record.modeloBoxId === "string") &&
(record.boxId === undefined || (
typeof record.boxId === "string" &&
boxes.some((box) => box.id === record.boxId) &&
record.modeloBoxId === undefined
)) &&
(record.dataRecebimento === undefined || record.dataRecebimento === "" || isValidISODate(record.dataRecebimento)) &&
(record.boxNumber === undefined || (
Number.isInteger(record.boxNumber) &&
record.boxNumber >= 1 &&
record.boxNumber <= 36 &&
record.modeloBoxId === undefined &&
(record.boxId === undefined || record.boxId === `number-${record.boxNumber}`)
)) &&
typeof record.dataConferencia === "string" &&
Number.isFinite(Number(record.qtdPacotes)) &&
Number.isFinite(Number(record.qtdPorPacote)) &&
Number.isFinite(Number(record.qtdTotalContada)) &&
Number(record.qtdPacotes) >= 0 &&
Number(record.qtdPorPacote) >= 0 &&
Number(record.qtdTotalContada) >= 0
);
if (!validRecords) throw new Error("Um ou mais registros do backup são inválidos.");

const inventoryItems = candidate.itensEstoque === undefined ? [] : candidate.itensEstoque;
if (!Array.isArray(inventoryItems) || !inventoryItems.every((item) =>
item &&
typeof item.id === "string" &&
typeof item.nome === "string" &&
["madeira", "pregos", "pallet", "box", "outro"].includes(item.categoria) &&
typeof item.unidade === "string" &&
item.unidade.trim() !== "" &&
typeof item.medida === "string"
)) {
throw new Error("Um ou mais itens de estoque são inválidos.");
}
const itemIds = new Set(inventoryItems.map((item) => item.id));
if (itemIds.size !== inventoryItems.length) throw new Error("Há itens de estoque com identificadores repetidos.");

const boxModels = candidate.modelosBox === undefined ? [] : candidate.modelosBox;
if (!Array.isArray(boxModels) || !boxModels.every((model) =>
model &&
typeof model.id === "string" &&
typeof model.nome === "string" &&
typeof model.itemId === "string" &&
itemIds.has(model.itemId) &&
inventoryItems.find((item) => item.id === model.itemId).categoria === "box" &&
Array.isArray(model.componentes) &&
model.componentes.length > 0 &&
model.componentes.every((component) =>
component &&
typeof component.itemId === "string" &&
itemIds.has(component.itemId) &&
inventoryItems.find((item) => item.id === component.itemId).categoria !== "box" &&
Number.isFinite(Number(component.quantidade)) &&
Number(component.quantidade) > 0
)
)) {
throw new Error("Um ou mais modelos de box são inválidos.");
}
const boxModelIds = new Set(boxModels.map((model) => model.id));
if (candidate.registros.some((record) =>
record.modeloBoxId && (
!boxModelIds.has(record.modeloBoxId) ||
record.tipoItem !== "Box" ||
record.boxNumber !== undefined ||
record.boxId !== undefined
)
)) {
throw new Error("Uma ou mais conferências fazem referência a modelos de box inválidos.");
}

const movements = candidate.movimentacoes === undefined ? [] : candidate.movimentacoes;
if (!Array.isArray(movements) || !movements.every((movement) =>
movement &&
typeof movement.id === "string" &&
["entrada", "saida"].includes(movement.operacao) &&
typeof movement.itemId === "string" &&
itemIds.has(movement.itemId) &&
Number.isFinite(Number(movement.quantidade)) &&
Number(movement.quantidade) > 0 &&
typeof movement.data === "string" &&
typeof movement.observacao === "string"
)) {
throw new Error("Uma ou mais movimentações de madeira são inválidas.");
}

const stockBalances = new Map();
movements.forEach((movement) => {
const direction = movement.operacao === "entrada" ? 1 : -1;
stockBalances.set(movement.itemId, (stockBalances.get(movement.itemId) || 0) + direction * Number(movement.quantidade));
});
if ([...stockBalances.values()].some((balance) => balance < 0)) {
throw new Error("O backup contém saídas maiores que as entradas de madeira.");
}

const financialEntries = candidate.lancamentosFinanceiros === undefined
? []
: candidate.lancamentosFinanceiros;
if (!Array.isArray(financialEntries) || !financialEntries.every((entry) =>
entry &&
typeof entry.id === "string" &&
["entrada", "saida"].includes(entry.operacao) &&
Number.isFinite(Number(entry.valor)) &&
Number(entry.valor) > 0 &&
typeof entry.data === "string" &&
typeof entry.descricao === "string"
)) {
throw new Error("Um ou mais lançamentos financeiros são inválidos.");
}
const cashBalanceInCents = financialEntries.reduce((balance, entry) =>
balance + (entry.operacao === "entrada" ? 1 : -1) * Math.round(Number(entry.valor) * 100), 0);
if (cashBalanceInCents < 0) throw new Error("O backup contém saídas maiores que as entradas financeiras.");

const types = candidate.tipos ? [...candidate.tipos] : [...fallback.tipos];
if (!types.some((type) => type.trim().toLocaleLowerCase("pt-BR") === "pallet")) {
types.push("Pallet");
}

return {
boxes,
clientes: candidate.clientes ? [...candidate.clientes] : [...fallback.clientes],
tipos: types,
medidas: candidate.medidas ? [...candidate.medidas] : [...fallback.medidas],
registros: candidate.registros.map((record) => (
record.boxNumber !== undefined && record.boxId === undefined
? { ...record, boxId: `number-${record.boxNumber}` }
: record
)),
movimentacoes: movements,
lancamentosFinanceiros: financialEntries,
itensEstoque: inventoryItems,
modelosBox: boxModels
};
}

function normalizeBoxes(candidateBoxes) {
if (candidateBoxes === undefined) return createDefaultBoxes();
if (!Array.isArray(candidateBoxes) || !candidateBoxes.every((box) =>
box &&
typeof box.id === "string" &&
box.id.trim() !== "" &&
typeof box.name === "string" &&
box.name.trim() !== "" &&
(box.number === undefined || box.number === null || (
Number.isInteger(box.number) &&
box.number >= 1 &&
box.number <= 36 &&
box.id === `number-${box.number}`
))
)) {
throw new Error("A lista de Boxes é inválida.");
}

const numberedBoxes = candidateBoxes.filter((box) => Number.isInteger(box.number));
if (new Set(numberedBoxes.map((box) => box.number)).size !== numberedBoxes.length) {
throw new Error("Há Boxes numerados duplicados.");
}
const customBoxes = candidateBoxes
.filter((box) => box.number === undefined || box.number === null)
.map((box) => ({ ...box, number: null }));
const boxes = [
...BOX_NUMBERS.map((number) =>
numberedBoxes.find((box) => box.number === number) || {
id: `number-${number}`,
name: `Box ${number}`,
number
}
),
...customBoxes
];

if (new Set(boxes.map((box) => box.id)).size !== boxes.length) {
throw new Error("Há Boxes com identificadores duplicados.");
}
const normalizedNames = boxes.map((box) => box.name.trim().toLocaleLowerCase("pt-BR"));
if (new Set(normalizedNames).size !== normalizedNames.length) {
throw new Error("Há Boxes com nomes duplicados.");
}
return boxes;
}

function saveState(nextState = state) {
try {
localStorage.setItem(STORAGE_KEY, JSON.stringify(nextState));
scheduleAutoSync(nextState);
return true;
} catch (error) {
console.error("Não foi possível salvar os dados locais.", error);
showToast("Não foi possível salvar. Verifique o espaço e as permissões do navegador.");
return false;
}
}

function loadSyncConfig() {
try {
const config = JSON.parse(localStorage.getItem(SYNC_CONFIG_KEY));
if (!config || typeof config.endpoint !== "string" || typeof config.accessKey !== "string") return null;
return config;
} catch (error) {
console.error("A configuração de sincronização está inválida.", error);
return null;
}
}

function loadSyncMetadata() {
try {
const metadata = JSON.parse(localStorage.getItem(SYNC_METADATA_KEY));
if (!metadata || typeof metadata.endpoint !== "string" ||
typeof metadata.revision !== "string" || typeof metadata.snapshot !== "string") return null;
return metadata;
} catch (error) {
console.error("Os dados de controle da sincronização estão inválidos.", error);
return null;
}
}

function setSyncMetadata(metadata) {
try {
localStorage.setItem(SYNC_METADATA_KEY, JSON.stringify(metadata));
syncMetadata = metadata;
} catch (error) {
console.error("Não foi possível salvar o controle da sincronização.", error);
throw new Error("A nuvem foi atualizada, mas não foi possível salvar o controle local da sincronização.");
}
}

function setSyncStatus(message, status = "offline") {
const badge = document.getElementById("status-badge");
if (!badge) return;
badge.textContent = message;
badge.className = `badge-${status}`;
badge.title = status === "online"
? "Dados sincronizados com o repositório privado."
: status === "syncing"
? "Sincronização em andamento."
: status === "error"
? "Há dados locais que ainda não foram sincronizados."
: "Dados salvos localmente neste aparelho.";
const syncStatus = document.getElementById("sync-status");
if (syncStatus) syncStatus.textContent = message;
}

function saveSyncConfig(endpoint, accessKey) {
let parsedUrl;
try {
parsedUrl = new URL(endpoint);
} catch {
throw new Error("Informe o endereço válido do Cloudflare Worker.");
}
if (parsedUrl.protocol !== "https:" || parsedUrl.pathname !== "/" || parsedUrl.search || parsedUrl.hash) {
throw new Error("O endereço deve ser a URL HTTPS principal do Worker, sem caminhos.");
}
if (accessKey.length < 32) throw new Error("A chave de acesso precisa ter pelo menos 32 caracteres.");

const config = { endpoint: parsedUrl.origin, accessKey };
try {
localStorage.setItem(SYNC_CONFIG_KEY, JSON.stringify(config));
} catch (error) {
console.error("Não foi possível guardar a configuração da sincronização.", error);
throw new Error("Não foi possível salvar a configuração neste aparelho.");
}
if (syncConfig && syncConfig.endpoint !== config.endpoint) {
try {
localStorage.removeItem(SYNC_METADATA_KEY);
} catch (error) {
console.error("Não foi possível limpar a revisão da sincronização anterior.", error);
throw new Error("Não foi possível atualizar a configuração neste aparelho.");
}
syncMetadata = null;
}
syncConfig = config;
}

async function requestSyncApi(method, body) {
if (!syncConfig) throw new Error("Configure primeiro a sincronização segura.");
const response = await fetch(`${syncConfig.endpoint}/data`, {
method,
headers: {
Authorization: `Bearer ${syncConfig.accessKey}`,
...(body === undefined ? {} : { "Content-Type": "application/json" })
},
...(body === undefined ? {} : { body: JSON.stringify(body) })
});
let result;
try {
result = await response.json();
} catch {
throw new Error("A API de sincronização retornou uma resposta inválida.");
}
if (!response.ok) {
const error = new Error(result.error || `Falha na sincronização (HTTP ${response.status}).`);
error.status = response.status;
throw error;
}
return result;
}

function isDefaultAppState(candidate) {
return JSON.stringify(candidate) === JSON.stringify(createDefaultState());
}

function serializedState(candidate) {
return JSON.stringify(candidate);
}

async function writeCloudState(candidate, expectedRevision) {
const result = await requestSyncApi("PUT", { state: candidate, expectedRevision });
if (typeof result.revision !== "string") throw new Error("A API não confirmou a versão salva.");
setSyncMetadata({
endpoint: syncConfig.endpoint,
revision: result.revision,
snapshot: serializedState(candidate)
});
}

function refreshAfterCloudLoad(cloudState) {
const normalized = normalizeState(cloudState, DEFAULT_STATE);
applyingRemoteState = true;
try {
if (!saveState(normalized)) throw new Error("Não foi possível salvar os dados baixados neste aparelho.");
state = normalized;
renderSelects();
renderStandardLists();
renderTable();
renderBoxHistory();
renderDashboard();
renderMovements();
renderFinancialEntries();
} finally {
applyingRemoteState = false;
}
}

async function synchronizeData(mode = "auto", localState = state) {
if (syncInProgress) throw new Error("Já existe uma sincronização em andamento.");
if (!syncConfig) throw new Error("Configure primeiro o endereço e a chave da sincronização.");
syncInProgress = true;
setSyncStatus("Sincronizando...", "syncing");
try {
const remote = await requestSyncApi("GET");
if (remote.state !== null && (typeof remote.state !== "object" || !Array.isArray(remote.state.registros))) {
throw new Error("Os dados recebidos da nuvem não têm um formato válido.");
}

if (mode === "download") {
if (!remote.state) throw new Error("Ainda não há dados salvos na nuvem.");
refreshAfterCloudLoad(remote.state);
setSyncMetadata({
endpoint: syncConfig.endpoint,
revision: remote.revision,
snapshot: serializedState(state)
});
} else if (mode === "upload") {
await writeCloudState(localState, remote.revision);
} else if (!remote.state) {
await writeCloudState(localState, null);
} else if (!syncMetadata || syncMetadata.endpoint !== syncConfig.endpoint) {
if (!isDefaultAppState(localState)) {
throw new Error("Há dados neste aparelho e na nuvem. Escolha enviar este aparelho ou baixar os dados da nuvem.");
}
refreshAfterCloudLoad(remote.state);
setSyncMetadata({
endpoint: syncConfig.endpoint,
revision: remote.revision,
snapshot: serializedState(state)
});
} else if (remote.revision === syncMetadata.revision) {
if (serializedState(localState) !== syncMetadata.snapshot) {
await writeCloudState(localState, remote.revision);
}
} else if (serializedState(localState) === syncMetadata.snapshot) {
refreshAfterCloudLoad(remote.state);
setSyncMetadata({
endpoint: syncConfig.endpoint,
revision: remote.revision,
snapshot: serializedState(state)
});
} else {
throw new Error("A nuvem e este aparelho têm alterações diferentes. Escolha enviar este aparelho ou baixar os dados da nuvem.");
}
setSyncStatus("Sincronizado", "online");
} catch (error) {
setSyncStatus("Sincronização pendente", "error");
throw error;
} finally {
syncInProgress = false;
}
}

function scheduleAutoSync(nextState) {
if (applyingRemoteState || !syncConfig || !syncMetadata ||
syncMetadata.endpoint !== syncConfig.endpoint) return;
clearTimeout(syncTimer);
const snapshot = JSON.parse(JSON.stringify(nextState));
syncTimer = setTimeout(() => {
if (syncInProgress) {
scheduleAutoSync(snapshot);
return;
}
synchronizeData("auto", snapshot).catch((error) => {
console.error("Não foi possível sincronizar os dados.", error);
showToast(`${error.message} Os dados continuam salvos neste aparelho.`);
});
}, 1200);
}

function initializeSyncControls() {
const form = document.getElementById("form-sync-settings");
const endpointInput = document.getElementById("sync-worker-url");
const accessKeyInput = document.getElementById("sync-access-key");
const syncButton = document.getElementById("btn-sync-now");
const downloadButton = document.getElementById("btn-sync-download");
const uploadButton = document.getElementById("btn-sync-upload");
if (!form || !endpointInput || !accessKeyInput) return;

if (syncConfig) {
endpointInput.value = syncConfig.endpoint;
accessKeyInput.value = syncConfig.accessKey;
setSyncStatus(syncMetadata ? "Sincronização configurada" : "Pronto para sincronizar");
}

window.addEventListener("online", () => {
if (!syncConfig || !syncMetadata) return;
synchronizeData().catch((error) => {
console.error("A sincronização após reconectar falhou.", error);
showToast(`${error.message} Os dados continuam salvos neste aparelho.`);
});
});

window.addEventListener("offline", () => {
if (syncConfig) setSyncStatus("Sem conexão — dados no aparelho", "error");
});

form.addEventListener("submit", (event) => {
event.preventDefault();
try {
saveSyncConfig(endpointInput.value.trim(), accessKeyInput.value);
setSyncStatus("Sincronização configurada");
showToast("Configuração salva neste aparelho. Toque em Sincronizar agora.");
} catch (error) {
showToast(error.message);
}
});

syncButton.addEventListener("click", async () => {
try {
await synchronizeData();
showToast("Dados sincronizados com sucesso.");
} catch (error) {
console.error("Falha ao sincronizar.", error);
showToast(error.message);
}
});

downloadButton.addEventListener("click", async () => {
if (!confirm("Substituir os dados deste aparelho pelos dados salvos na nuvem?")) return;
try {
await synchronizeData("download");
showToast("Dados da nuvem carregados neste aparelho.");
} catch (error) {
console.error("Falha ao baixar os dados.", error);
showToast(error.message);
}
});

uploadButton.addEventListener("click", async () => {
if (!confirm("Substituir todos os dados da nuvem pelos dados deste aparelho? Essa ação pode apagar alterações feitas em outros aparelhos.")) return;
try {
await synchronizeData("upload");
showToast("Dados deste aparelho enviados para a nuvem.");
} catch (error) {
console.error("Falha ao enviar os dados.", error);
showToast(error.message);
}
});
}

function showToast(msg) {
const toast = document.getElementById("toast");
toast.textContent = msg;
toast.classList.add("show");
clearTimeout(toast._timer);
toast._timer = setTimeout(() => toast.classList.remove("show"), 2600);
}

function getTodayISO() {
const now = new Date();
const offset = now.getTimezoneOffset() * 60000;
return new Date(now - offset).toISOString().split("T")[0];
}

function isValidISODate(value) {
if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
const date = new Date(`${value}T00:00:00Z`);
return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function formatDateBR(iso) {
if (!iso) return "";
const [y, m, d] = iso.split("-");
return `${d}/${m}/${y}`;
}

function formatStorageDuration(receiptDate) {
if (!receiptDate) return "Não informado";
const elapsedDays = Math.floor(
(Date.parse(`${getTodayISO()}T00:00:00Z`) - Date.parse(`${receiptDate}T00:00:00Z`)) / 86400000
);
if (elapsedDays < 0) return "Data futura";
return `${formatNumber(elapsedDays)} ${elapsedDays === 1 ? "dia" : "dias"}`;
}

function formatNumber(n) {
return Number(n || 0).toLocaleString("pt-BR");
}

function formatQuantity(n) {
return Number(n || 0).toLocaleString("pt-BR", { maximumFractionDigits: 4 });
}

function getInventoryItem(id) {
return state.itensEstoque.find((item) => item.id === id);
}

function getInventoryLabel(item) {
if (!item) return "Item removido";
return [item.nome, item.medida].filter(Boolean).join(" — ");
}

function getCategoryLabel(category) {
const labels = {
madeira: "Madeira",
pregos: "Pregos",
pallet: "Pallet",
box: "Box",
outro: "Outro"
};
return labels[category] || category;
}

function formatCurrency(value) {
return Number(value || 0).toLocaleString("pt-BR", {
style: "currency",
currency: "BRL"
});
}

function getCashBalanceInCents(entries = state.lancamentosFinanceiros) {
return entries.reduce((balance, entry) =>
balance + (entry.operacao === "entrada" ? 1 : -1) * Math.round(Number(entry.valor) * 100), 0);
}

function getItemBalance(itemId, movements = state.movimentacoes) {
return movements.reduce((balance, movement) => {
if (movement.itemId !== itemId) return balance;
return balance + (movement.operacao === "entrada" ? 1 : -1) * Number(movement.quantidade);
}, 0);
}

function getStockSummary() {
const summary = new Map(state.itensEstoque.map((item) => [item.id, {
...item,
entradas: 0,
saidas: 0
}]));
state.movimentacoes.forEach((movement) => {
const row = summary.get(movement.itemId);
if (!row) return;
if (movement.operacao === "entrada") row.entradas += Number(movement.quantidade);
else row.saidas += Number(movement.quantidade);
});
return [...summary.values()].sort((a, b) =>
a.categoria.localeCompare(b.categoria, "pt-BR") || a.nome.localeCompare(b.nome, "pt-BR"));
}

// Tabs
document.querySelectorAll(".tab-btn").forEach((btn) => {
btn.addEventListener("click", () => {
switchTab(btn.dataset.tab);
});
});

document.getElementById("btn-box-management").addEventListener("click", () => {
switchTab("tab-padroes");
document.getElementById("input-new-box-name").focus();
});

function switchTab(tabId) {
document.querySelectorAll(".tab-btn").forEach((b) => {
const active = b.dataset.tab === tabId;
b.classList.toggle("active", active);
b.setAttribute("aria-selected", active ? "true" : "false");
});
document.querySelectorAll(".tab-panel").forEach((panel) => {
panel.classList.toggle("active", panel.id === tabId);
});
}

// Populate Selects & Lists
function renderSelects() {
const selectCliente = document.getElementById("select-cliente");
const selectTipo = document.getElementById("select-tipo");
const selectItemType = document.getElementById("select-item-type");
const selectMedida = document.getElementById("select-medida");
const filterCliente = document.getElementById("filter-cliente");
const filterTipo = document.getElementById("filter-tipo");
const movementItem = document.getElementById("mov-item");

const curCliente = selectCliente.value;
const curTipo = selectTipo.value;
const curItemType = selectItemType.value;
const curMedida = selectMedida.value;
const curFCliente = filterCliente.value;
const curFTipo = filterTipo.value;
const curMovementItem = movementItem.value;
const conferenceTypes = [...state.tipos];
if (!conferenceTypes.some((type) => type.trim().toLocaleLowerCase("pt-BR") === "box")) {
conferenceTypes.push("Box");
}

fillSelect(selectCliente, state.clientes, "", curCliente);
renderConferenceTypeSelect(curTipo);
renderBoxNameEditSelect();
renderItemTypeSelect(curItemType);
fillSelect(selectMedida, state.medidas, "", curMedida);

fillSelect(filterCliente, state.clientes, "Todos os clientes", curFCliente);
fillSelect(filterTipo, conferenceTypes, "Todos os itens", curFTipo);
updateVolumePreview();
renderInventorySelects(curMovementItem);
}

function renderItemTypeSelect(selectedValue = document.getElementById("select-item-type").value) {
const select = document.getElementById("select-item-type");
fillSelect(select, state.tipos, "", selectedValue);

if (selectedValue && !state.tipos.includes(selectedValue)) {
const legacyGroup = document.createElement("optgroup");
legacyGroup.label = "Registro anterior";
const option = document.createElement("option");
option.value = selectedValue;
option.textContent = selectedValue === "Box" ? "Tipo anterior não informado" : selectedValue;
option.selected = true;
legacyGroup.appendChild(option);
select.appendChild(legacyGroup);
}
}

function renderConferenceTypeSelect(selectedValue = document.getElementById("select-tipo").value) {
const select = document.getElementById("select-tipo");
select.innerHTML = '<option value=""></option>';
state.boxes.forEach((box) => {
const option = document.createElement("option");
option.value = `${BOX_ENTRY_VALUE_PREFIX}${box.id}`;
option.textContent = box.name;
option.selected = option.value === selectedValue;
select.appendChild(option);
});

if (selectedValue.startsWith(LEGACY_TYPE_VALUE_PREFIX) || selectedValue.startsWith(BOX_MODEL_VALUE_PREFIX)) {
const legacyGroup = document.createElement("optgroup");
legacyGroup.label = "Registro anterior";
const option = document.createElement("option");
option.value = selectedValue;
option.textContent = selectedValue.startsWith(BOX_MODEL_VALUE_PREFIX)
? state.modelosBox.find((model) => model.id === selectedValue.slice(BOX_MODEL_VALUE_PREFIX.length))?.nome || "Box de modelo anterior"
: selectedValue.slice(LEGACY_TYPE_VALUE_PREFIX.length);
option.selected = true;
legacyGroup.appendChild(option);
select.appendChild(legacyGroup);
}
}

function renderBoxNameEditSelect(selectedId = document.getElementById("select-edit-box").value) {
const select = document.getElementById("select-edit-box");
select.innerHTML = '<option value=""></option>';
state.boxes.forEach((box) => {
const option = document.createElement("option");
option.value = box.id;
option.textContent = box.name;
option.selected = box.id === selectedId;
select.appendChild(option);
});

const selectedBox = state.boxes.find((box) => box.id === selectedId);
const nameInput = document.getElementById("input-edit-box-name");
nameInput.value = selectedBox ? selectedBox.name : "";
nameInput.disabled = !selectedBox;
document.getElementById("btn-rename-box").disabled = !selectedBox;
}

function getSelectedBox(selectedValue) {
if (!selectedValue.startsWith(BOX_ENTRY_VALUE_PREFIX)) return null;
const boxId = selectedValue.slice(BOX_ENTRY_VALUE_PREFIX.length);
return state.boxes.find((box) => box.id === boxId) || null;
}

function getRecordBoxId(record) {
return record.boxId || (record.boxNumber ? `number-${record.boxNumber}` : "");
}

function getRecordBox(record) {
const boxId = getRecordBoxId(record);
return boxId ? state.boxes.find((box) => box.id === boxId) || null : null;
}

function getRecordBoxName(record) {
const box = getRecordBox(record);
return box ? box.name : "";
}

function getConferenceBoxModelId(selectedValue) {
return selectedValue.startsWith(BOX_MODEL_VALUE_PREFIX)
? selectedValue.slice(BOX_MODEL_VALUE_PREFIX.length)
: "";
}

function getItemTypeLabel(record) {
if (record.modeloBoxId) {
return state.modelosBox.find((model) => model.id === record.modeloBoxId)?.nome || record.tipoItem;
}
return getRecordBoxId(record) && record.tipoItem === "Box" ? "Tipo não informado" : record.tipoItem;
}

function getConferenceTypeLabel(record) {
const itemType = getItemTypeLabel(record);
const boxName = getRecordBoxName(record);
return boxName ? `${boxName} — ${itemType}` : itemType;
}

function calculateVolumeM3(measure, quantity) {
const dimensions = String(measure || "").match(/\d+(?:[.,]\d+)?/g) || [];
if (dimensions.length !== 3) return null;

const volumePerPiece = dimensions
.map((dimension) => Number(dimension.replace(",", ".")))
.reduce((volume, dimension) => volume * dimension, 1);
const total = Number(quantity);
if (!Number.isFinite(volumePerPiece) || volumePerPiece <= 0 || !Number.isFinite(total) || total < 0) return null;
return volumePerPiece * total;
}

function formatVolumeValue(volume) {
return volume.toLocaleString("pt-BR", { maximumFractionDigits: 12 });
}

function formatVolumeM3(measure, quantity) {
const volume = calculateVolumeM3(measure, quantity);
return volume === null ? "—" : formatVolumeValue(volume);
}

function updateVolumePreview() {
const measure = document.getElementById("select-medida").value;
const quantity = document.getElementById("input-total").value;
const volume = quantity === "" ? null : calculateVolumeM3(measure, quantity);
document.getElementById("input-volume-m3").value = volume === null ? "" : formatVolumeValue(volume);
}

document.getElementById("select-medida").addEventListener("change", updateVolumePreview);

function renderInventorySelects(selectedItemId = document.getElementById("mov-item").value) {
const select = document.getElementById("mov-item");
select.innerHTML = '<option value="">Selecione um item...</option>';
state.itensEstoque.forEach((item) => {
const option = document.createElement("option");
option.value = item.id;
option.textContent = `${getCategoryLabel(item.categoria)} — ${getInventoryLabel(item)} (${item.unidade})`;
option.selected = item.id === selectedItemId;
select.appendChild(option);
});
updateMovementUnitHint();
}

function updateMovementUnitHint() {
const item = getInventoryItem(document.getElementById("mov-item").value);
document.getElementById("mov-unit-hint").textContent = item
? `Quantidade em ${item.unidade}.`
: state.itensEstoque.length
? "Selecione o item para ver sua unidade de contagem."
: "Cadastre itens em Padrões antes de movimentar o estoque.";
}

function fillSelect(selectEl, items, placeholder, selectedValue) {
selectEl.innerHTML = `<option value="">${placeholder}</option>`;
items.forEach((item) => {
const opt = document.createElement("option");
opt.value = item;
opt.textContent = item;
if (item === selectedValue) opt.selected = true;
selectEl.appendChild(opt);
});
}

function renderStandardLists() {
renderList("clientes", "list-clientes");
renderList("tipos", "list-tipos");
renderList("medidas", "list-medidas");
renderInventoryItems();
}

document.getElementById("select-edit-box").addEventListener("change", (event) => {
renderBoxNameEditSelect(event.currentTarget.value);
});

document.getElementById("form-add-box").addEventListener("submit", (event) => {
event.preventDefault();
const name = document.getElementById("input-new-box-name").value.trim();
if (!name) {
showToast("Informe um nome para o Box.");
return;
}
if (state.boxes.some((box) => box.name.trim().toLocaleLowerCase("pt-BR") === name.toLocaleLowerCase("pt-BR"))) {
showToast("Já existe um Box com esse nome.");
return;
}

const box = { id: createEntryId("custom-box"), name, number: null };
const boxes = [...state.boxes, box];
if (!saveState({ ...state, boxes })) return;
state = { ...state, boxes };
document.getElementById("input-new-box-name").value = "";
renderSelects();
renderBoxHistory();
renderTable();
showToast(`${name} incluído com sucesso.`);
});

document.getElementById("form-rename-box").addEventListener("submit", (event) => {
event.preventDefault();
const boxId = document.getElementById("select-edit-box").value;
const name = document.getElementById("input-edit-box-name").value.trim();
const box = state.boxes.find((item) => item.id === boxId);
if (!box) return;
if (!name) {
showToast("Informe o novo nome do Box.");
return;
}
if (state.boxes.some((item) =>
item.id !== boxId &&
item.name.trim().toLocaleLowerCase("pt-BR") === name.toLocaleLowerCase("pt-BR")
)) {
showToast("Já existe um Box com esse nome.");
return;
}

const boxes = state.boxes.map((item) => item.id === boxId ? { ...item, name } : item);
if (!saveState({ ...state, boxes })) return;
state = { ...state, boxes };
renderSelects();
renderBoxHistory();
renderTable();
showToast(`${name} atualizado com sucesso.`);
});

function renderList(key, ulId) {
const ul = document.getElementById(ulId);
ul.innerHTML = "";
if (state[key].length === 0) {
ul.innerHTML = `<li style="color:#6b7280;font-size:0.84rem;">Nenhum item cadastrado.</li>`;
return;
}
state[key].forEach((item, index) => {
const li = document.createElement("li");
const span = document.createElement("span");
span.textContent = item;

const btn = document.createElement("button");
btn.type = "button";
btn.className = "btn-del-item";
btn.textContent = "Excluir";
btn.addEventListener("click", () => {
state[key].splice(index, 1);
saveState();
renderSelects();
renderStandardLists();
showToast("Item padrão removido.");
});

li.appendChild(span);
li.appendChild(btn);
ul.appendChild(li);
});
}

function renderInventoryItems() {
const list = document.getElementById("list-itens-estoque");
list.innerHTML = "";
if (state.itensEstoque.length === 0) {
list.innerHTML = '<li class="list-empty">Nenhum item de estoque cadastrado.</li>';
} else {
state.itensEstoque.forEach((item) => {
const li = document.createElement("li");
const description = document.createElement("span");
description.textContent = `${getCategoryLabel(item.categoria)} · ${getInventoryLabel(item)} (${item.unidade})`;

const button = document.createElement("button");
button.type = "button";
button.className = "btn-del-item";
button.textContent = "Excluir";
button.addEventListener("click", () => deleteInventoryItem(item.id));
li.append(description, button);
list.appendChild(li);
});
}

renderInventorySelects();
}

function deleteInventoryItem(id) {
if (state.modelosBox.some((model) => model.itemId === id)) {
showToast("Exclua o modelo de box vinculado antes de remover este item.");
return;
}
if (state.movimentacoes.some((movement) => movement.itemId === id)) {
showToast("Este item tem movimentações no histórico e não pode ser excluído.");
return;
}
if (state.modelosBox.some((model) => model.componentes.some((component) => component.itemId === id))) {
showToast("Este item faz parte de um modelo de box e não pode ser excluído.");
return;
}
if (!window.confirm("Excluir este item do cadastro de estoque?")) return;

const items = state.itensEstoque.filter((item) => item.id !== id);
if (!saveState({ ...state, itensEstoque: items })) return;
state.itensEstoque = items;
renderInventoryItems();
renderDashboard();
showToast("Item de estoque excluído.");
}

document.getElementById("form-item-estoque").addEventListener("submit", (event) => {
event.preventDefault();
const item = {
id: createEntryId("item"),
nome: document.getElementById("item-nome").value.trim(),
categoria: document.getElementById("item-categoria").value,
unidade: document.getElementById("item-unidade").value.trim(),
medida: document.getElementById("item-medida").value.trim()
};
const duplicate = state.itensEstoque.some((existing) =>
existing.nome.toLocaleLowerCase() === item.nome.toLocaleLowerCase() &&
existing.categoria === item.categoria &&
existing.medida.toLocaleLowerCase() === item.medida.toLocaleLowerCase() &&
existing.unidade.toLocaleLowerCase() === item.unidade.toLocaleLowerCase()
);
if (duplicate) {
showToast("Este item já está cadastrado.");
return;
}

const items = [...state.itensEstoque, item];
if (!saveState({ ...state, itensEstoque: items })) return;
state.itensEstoque = items;
event.currentTarget.reset();
renderInventoryItems();
renderDashboard();
showToast("Item de estoque cadastrado.");
});

// Add Standard Forms
document.querySelectorAll(".add-standard-form").forEach((form) => {
form.addEventListener("submit", (e) => {
e.preventDefault();
const listKey = form.dataset.list;
const input = form.querySelector("input");
const val = input.value.trim();
if (!val) return;

if (!state[listKey].some((x) => x.toLowerCase() === val.toLowerCase())) {
state[listKey].push(val);
saveState();
renderSelects();
renderStandardLists();
showToast(`"${val}" adicionado aos padrões!`);
} else {
showToast("Este item já está cadastrado.");
}
input.value = "";
});
});

// Quick "+" button next to selects
document.querySelectorAll(".btn-quick-add").forEach((btn) => {
btn.addEventListener("click", () => {
const target = btn.dataset.target;
const labels = {
clientes: "Novo Cliente:",
tipos: "Novo Tipo de Item (Madeira):",
medidas: "Nova Medida (ex: 1,10 x 0,07 x 0,019):"
};
const selectIds = {
clientes: "select-cliente",
tipos: "select-item-type",
medidas: "select-medida"
};
const novo = prompt(labels[target]);
if (!novo || !novo.trim()) return;
const clean = novo.trim();
if (!state[target].some((x) => x.toLowerCase() === clean.toLowerCase())) {
state[target].push(clean);
saveState();
renderSelects();
renderStandardLists();
}
document.getElementById(selectIds[target]).value = clean;
updateVolumePreview();
showToast(`"${clean}" selecionado!`);
});
});

// Auto-calculate total units
const inputPacotes = document.getElementById("input-pacotes");
const inputUnidPacote = document.getElementById("input-unid-pacote");
const inputTotal = document.getElementById("input-total");
const totalModeTag = document.getElementById("total-mode-tag");

function updateAutoTotal() {
if (manualTotalOverride && !legacyBoxQuantityWithoutPackages) return;
manualTotalOverride = false;
legacyBoxQuantityWithoutPackages = false;
const p = Number(inputPacotes.value) || 0;
const u = Number(inputUnidPacote.value) || 0;
inputTotal.value = p * u > 0 ? p * u : "";
totalModeTag.textContent = "Auto";
totalModeTag.className = "tag-auto";
updateVolumePreview();
}

inputPacotes.addEventListener("input", updateAutoTotal);
inputUnidPacote.addEventListener("input", updateAutoTotal);

inputTotal.addEventListener("input", () => {
manualTotalOverride = true;
legacyBoxQuantityWithoutPackages = false;
totalModeTag.textContent = "Manual";
totalModeTag.className = "tag-manual";
updateVolumePreview();
});

// Save or Update Conferência
const formConferencia = document.getElementById("form-conferencia");
formConferencia.addEventListener("submit", (e) => {
e.preventDefault();

const editId = document.getElementById("edit-id").value;
const selectedType = document.getElementById("select-tipo").value;
const selectedItemType = document.getElementById("select-item-type").value;
const selectedBox = getSelectedBox(selectedType);
const boxModelId = getConferenceBoxModelId(selectedType);
const boxModel = boxModelId
? state.modelosBox.find((model) => model.id === boxModelId)
: null;
if (boxModelId && !boxModel) {
showToast("O modelo de box selecionado não está mais cadastrado.");
return;
}
const totalQuantity = Number(inputTotal.value);
if (selectedBox && (!Number.isInteger(totalQuantity) || totalQuantity < 1)) {
showToast("Informe uma quantidade total válida para o Box.");
return;
}
const receiptDate = document.getElementById("input-data-recebimento").value;
if (!isValidISODate(receiptDate) || receiptDate > getTodayISO()) {
showToast("Informe uma data de recebimento válida, que não seja futura.");
return;
}
const record = {
id: editId || (selectedBox ? createEntryId("box-record") : String(Date.now())),
cliente: document.getElementById("select-cliente").value,
tipoItem: selectedItemType,
medida: document.getElementById("select-medida").value,
qtdPacotes: Number(inputPacotes.value) || 0,
qtdPorPacote: Number(inputUnidPacote.value) || 0,
qtdTotalContada: totalQuantity || 0,
dataRecebimento: receiptDate,
dataConferencia: document.getElementById("input-data").value,
...(selectedBox ? {
boxId: selectedBox.id,
...(Number.isInteger(selectedBox.number) ? { boxNumber: selectedBox.number } : {})
} : {}),
...(boxModel ? { modeloBoxId: boxModel.id } : {})
};

if (editId) {
const idx = state.registros.findIndex((r) => r.id === editId);
if (idx !== -1) state.registros[idx] = record;
showToast(selectedBox ? `${selectedBox.name} atualizado!` : "Conferência atualizada!");
} else {
state.registros.unshift(record);
showToast(selectedBox ? `${selectedBox.name} salvo com sucesso!` : "Conferência salva com sucesso!");
}

saveState();
resetForm();
renderTable();
renderBoxHistory();
});

function resetForm() {
document.getElementById("edit-id").value = "";
document.getElementById("form-title").textContent = "Registrar Box";
document.getElementById("btn-submit").textContent = "Salvar Box";
document.getElementById("btn-cancel-edit").classList.add("hidden");

document.getElementById("select-tipo").value = "";
renderConferenceTypeSelect("");
document.getElementById("select-item-type").value = "";
renderItemTypeSelect("");
document.getElementById("select-cliente").value = "";
document.getElementById("select-medida").value = "";
inputPacotes.value = "";
inputUnidPacote.value = "";
inputTotal.value = "";
updateVolumePreview();
manualTotalOverride = false;
legacyBoxQuantityWithoutPackages = false;
totalModeTag.textContent = "Auto";
totalModeTag.className = "tag-auto";
document.getElementById("input-data").value = getTodayISO();
document.getElementById("input-data-recebimento").value = "";
document.getElementById("input-data-recebimento").max = getTodayISO();
}

function renderBoxHistory() {
const tbody = document.getElementById("tbody-conferencias-box");
const records = state.registros
.filter((record) => getRecordBoxId(record))
.sort((a, b) => b.dataConferencia.localeCompare(a.dataConferencia) || b.id.localeCompare(a.id));

tbody.innerHTML = records.map((record) => `
<tr>
<td><strong>${escapeHTML(getRecordBoxName(record))}</strong></td>
<td>${escapeHTML(getItemTypeLabel(record))}</td>
<td>${record.dataRecebimento ? formatDateBR(record.dataRecebimento) : "Não informado"}</td>
<td>${formatStorageDuration(record.dataRecebimento)}</td>
<td>${formatDateBR(record.dataConferencia)}</td>
<td>${escapeHTML(record.cliente)}</td>
<td>${escapeHTML(record.medida)}</td>
<td class="num">${record.qtdPacotes === 0 && record.qtdPorPacote === 0 ? "—" : formatNumber(record.qtdPacotes)}</td>
<td class="num">${record.qtdPacotes === 0 && record.qtdPorPacote === 0 ? "—" : formatNumber(record.qtdPorPacote)}</td>
<td class="num">${formatNumber(record.qtdTotalContada)}</td>
<td class="num">${formatVolumeM3(record.medida, record.qtdTotalContada)}</td>
<td class="actions-col">
    <div class="row-actions">
        <button type="button" class="btn-icon edit edit-box-record" data-id="${escapeHTML(record.id)}">Editar</button>
        <button type="button" class="btn-icon delete delete-box-record" data-id="${escapeHTML(record.id)}">Excluir</button>
    </div>
</td>
</tr>
`).join("");
document.getElementById("empty-box-records").classList.toggle("hidden", records.length > 0);

tbody.querySelectorAll(".edit-box-record").forEach((button) => {
button.addEventListener("click", () => startEdit(button.dataset.id));
});
tbody.querySelectorAll(".delete-box-record").forEach((button) => {
button.addEventListener("click", () => deleteRecord(button.dataset.id));
});
}

document.getElementById("btn-cancel-edit").addEventListener("click", resetForm);

// Render Excel-like Table & KPIs
function getFilteredRecords() {
const fCliente = document.getElementById("filter-cliente").value;
const fTipo = document.getElementById("filter-tipo").value;
const fData = document.getElementById("filter-data").value;

return state.registros.filter((r) => {
if (fCliente && r.cliente !== fCliente) return false;
if (fTipo && r.tipoItem !== fTipo) return false;
if (fData && r.dataConferencia !== fData) return false;
return true;
});
}

function getMaterialTotals(records) {
const totals = new Map();
records.forEach((record) => {
const key = JSON.stringify([
record.cliente,
record.tipoItem,
getRecordBoxId(record),
record.modeloBoxId || "",
record.medida
]);
if (!totals.has(key)) {
totals.set(key, {
cliente: record.cliente,
tipoItem: getConferenceTypeLabel(record),
medida: record.medida,
registros: 0,
totalContado: 0,
totalM3: 0,
volumeCalculavel: true
});
}

const group = totals.get(key);
group.registros += 1;
group.totalContado += Number(record.qtdTotalContada || 0);
const volume = calculateVolumeM3(record.medida, record.qtdTotalContada);
if (volume === null) group.volumeCalculavel = false;
else group.totalM3 += volume;
});

return [...totals.values()].sort((a, b) =>
a.cliente.localeCompare(b.cliente, "pt-BR") ||
a.tipoItem.localeCompare(b.tipoItem, "pt-BR") ||
a.medida.localeCompare(b.medida, "pt-BR"));
}

function renderTable() {
const tbody = document.getElementById("tbody-conferencias");
const emptyState = document.getElementById("empty-state");
const filtered = getFilteredRecords();
const materialTotals = getMaterialTotals(filtered);

document.getElementById("badge-count").textContent = state.registros.length;
tbody.innerHTML = "";

filtered.forEach((r) => {
const tr = document.createElement("tr");
tr.innerHTML = `
<td>${formatDateBR(r.dataConferencia)}</td>
<td><strong>${escapeHTML(r.cliente)}</strong></td>
<td>${escapeHTML(getConferenceTypeLabel(r))}</td>
<td>${escapeHTML(r.medida)}</td>
<td class="num">${getRecordBoxId(r) && r.qtdPacotes === 0 && r.qtdPorPacote === 0 ? "—" : formatNumber(r.qtdPacotes)}</td>
<td class="num">${getRecordBoxId(r) && r.qtdPacotes === 0 && r.qtdPorPacote === 0 ? "—" : formatNumber(r.qtdPorPacote)}</td>
<td class="num"><strong>${formatNumber(r.qtdTotalContada)}</strong></td>
<td class="num">${formatVolumeM3(r.medida, r.qtdTotalContada)}</td>
<td class="actions-col">
    <div class="row-actions">
        <button type="button" class="btn-icon edit" data-id="${escapeHTML(r.id)}">Editar</button>
        <button type="button" class="btn-icon delete" data-id="${escapeHTML(r.id)}">Excluir</button>
    </div>
</td>
`;
tbody.appendChild(tr);
});

const clients = new Set(filtered.map((record) => record.cliente));
const materials = new Set(filtered.map((record) =>
JSON.stringify([record.tipoItem, getRecordBoxId(record), record.modeloBoxId || "", record.medida])
));
document.getElementById("kpi-registros").textContent = formatNumber(filtered.length);
document.getElementById("kpi-clientes").textContent = formatNumber(clients.size);
document.getElementById("kpi-materiais").textContent = formatNumber(materials.size);

const summaryBody = document.getElementById("tbody-resumo-materiais");
summaryBody.innerHTML = materialTotals.map((group) => `
<tr>
<td><strong>${escapeHTML(group.cliente)}</strong></td>
<td>${escapeHTML(group.tipoItem)}</td>
<td>${escapeHTML(group.medida)}</td>
<td class="num">${formatNumber(group.registros)}</td>
<td class="num"><strong>${formatNumber(group.totalContado)}</strong></td>
<td class="num">${group.volumeCalculavel ? formatVolumeValue(group.totalM3) : "—"}</td>
</tr>
`).join("");
document.getElementById("empty-summary").classList.toggle("hidden", materialTotals.length > 0);

emptyState.classList.toggle("hidden", filtered.length > 0);

// Bind Edit & Delete
tbody.querySelectorAll(".btn-icon.edit").forEach((btn) => {
btn.addEventListener("click", () => startEdit(btn.dataset.id));
});
tbody.querySelectorAll(".btn-icon.delete").forEach((btn) => {
btn.addEventListener("click", () => deleteRecord(btn.dataset.id));
});
}

function escapeHTML(str) {
return String(str || "")
.replace(/&/g, "&amp;")
.replace(/</g, "&lt;")
.replace(/>/g, "&gt;")
.replace(/"/g, "&quot;");
}

function startEdit(id) {
const r = state.registros.find((item) => item.id === id);
if (!r) return;

const boxId = getRecordBoxId(r);
const box = getRecordBox(r);
const isBoxEntry = Boolean(boxId);
const selectedType = isBoxEntry
? `${BOX_ENTRY_VALUE_PREFIX}${boxId}`
: r.modeloBoxId
? `${BOX_MODEL_VALUE_PREFIX}${r.modeloBoxId}`
: `${LEGACY_TYPE_VALUE_PREFIX}${r.tipoItem}`;
renderConferenceTypeSelect(selectedType);
renderItemTypeSelect(r.tipoItem);
document.getElementById("edit-id").value = r.id;
document.getElementById("select-cliente").value = r.cliente;
document.getElementById("select-tipo").value = selectedType;
document.getElementById("select-medida").value = r.medida;
inputPacotes.value = r.qtdPacotes;
inputUnidPacote.value = r.qtdPorPacote;
inputTotal.value = r.qtdTotalContada;
updateVolumePreview();
document.getElementById("input-data").value = r.dataConferencia;
document.getElementById("input-data-recebimento").value = r.dataRecebimento || "";

manualTotalOverride = r.qtdTotalContada !== r.qtdPacotes * r.qtdPorPacote;
legacyBoxQuantityWithoutPackages = isBoxEntry && r.qtdPacotes === 0 && r.qtdPorPacote === 0;
totalModeTag.textContent = manualTotalOverride ? "Manual" : "Auto";
totalModeTag.className = manualTotalOverride ? "tag-manual" : "tag-auto";

document.getElementById("form-title").textContent = isBoxEntry
? `Editando ${box.name}`
: "Editando Conferência anterior";
document.getElementById("btn-submit").textContent = isBoxEntry ? "Atualizar Box" : "Atualizar registro";
document.getElementById("btn-cancel-edit").classList.remove("hidden");
switchTab("tab-lancamento");
}

function deleteRecord(id) {
if (!confirm("Deseja realmente excluir este lançamento?")) return;
state.registros = state.registros.filter((r) => r.id !== id);
saveState();
renderTable();
renderBoxHistory();
showToast("Registro excluído.");
}

function createEntryId(prefix) {
return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function renderDashboard() {
const summary = getStockSummary();
document.getElementById("dash-entradas").textContent = formatNumber(
state.movimentacoes.filter((movement) => movement.operacao === "entrada").length
);
document.getElementById("dash-saidas").textContent = formatNumber(
state.movimentacoes.filter((movement) => movement.operacao === "saida").length
);
document.getElementById("dash-itens").textContent = formatNumber(
summary.filter((row) => row.entradas - row.saidas > 0).length
);

const tbody = document.getElementById("tbody-saldo-estoque");
tbody.innerHTML = summary.map((row) => `
<tr>
<td>${escapeHTML(getCategoryLabel(row.categoria))}</td>
<td><strong>${escapeHTML(row.nome)}</strong></td>
<td>${escapeHTML(row.medida || "—")}</td>
<td class="num">${formatQuantity(row.entradas)} ${escapeHTML(row.unidade)}</td>
<td class="num">${formatQuantity(row.saidas)} ${escapeHTML(row.unidade)}</td>
<td class="num"><strong>${formatQuantity(row.entradas - row.saidas)} ${escapeHTML(row.unidade)}</strong></td>
</tr>
`).join("");
document.getElementById("empty-stock").classList.toggle("hidden", summary.length > 0);
}

function renderMovements() {
const tbody = document.getElementById("tbody-movimentacoes");
const movements = [...state.movimentacoes].sort((a, b) =>
b.data.localeCompare(a.data) || b.id.localeCompare(a.id));

tbody.innerHTML = movements.map((movement) => `
<tr>
<td>${formatDateBR(movement.data)}</td>
<td><span class="movement-type ${movement.operacao}">${movement.operacao === "entrada" ? "Entrada" : "Saída"}</span></td>
<td>${escapeHTML(getCategoryLabel(getInventoryItem(movement.itemId)?.categoria || "outro"))}</td>
<td>${escapeHTML(getInventoryLabel(getInventoryItem(movement.itemId)))}</td>
<td class="num">${formatQuantity(movement.quantidade)} ${escapeHTML(getInventoryItem(movement.itemId)?.unidade || "")}</td>
<td>${escapeHTML(movement.observacao)}</td>
<td class="actions-col"><button type="button" class="btn-icon delete delete-movement" data-id="${escapeHTML(movement.id)}">Excluir</button></td>
</tr>
`).join("");

document.getElementById("empty-movements").classList.toggle("hidden", movements.length > 0);
tbody.querySelectorAll(".delete-movement").forEach((button) => {
button.addEventListener("click", () => deleteMovement(button.dataset.id));
});
}

function renderFinancialEntries() {
const entries = state.lancamentosFinanceiros;
const receivedCents = entries.reduce((total, entry) =>
total + (entry.operacao === "entrada" ? Math.round(Number(entry.valor) * 100) : 0), 0);
const paidCents = entries.reduce((total, entry) =>
total + (entry.operacao === "saida" ? Math.round(Number(entry.valor) * 100) : 0), 0);

document.getElementById("cash-entradas").textContent = formatCurrency(receivedCents / 100);
document.getElementById("cash-saidas").textContent = formatCurrency(paidCents / 100);
document.getElementById("cash-saldo").textContent = formatCurrency(getCashBalanceInCents() / 100);

const tbody = document.getElementById("tbody-valores");
const sortedEntries = [...entries].sort((a, b) =>
b.data.localeCompare(a.data) || b.id.localeCompare(a.id));
tbody.innerHTML = sortedEntries.map((entry) => `
<tr>
<td>${formatDateBR(entry.data)}</td>
<td><span class="movement-type ${entry.operacao}">${entry.operacao === "entrada" ? "Entrada" : "Saída"}</span></td>
<td>${escapeHTML(entry.descricao)}</td>
<td class="num">${formatCurrency(entry.valor)}</td>
<td class="actions-col"><button type="button" class="btn-icon delete delete-value" data-id="${escapeHTML(entry.id)}">Excluir</button></td>
</tr>
`).join("");

document.getElementById("empty-values").classList.toggle("hidden", entries.length > 0);
tbody.querySelectorAll(".delete-value").forEach((button) => {
button.addEventListener("click", () => deleteFinancialEntry(button.dataset.id));
});
}

function deleteMovement(id) {
const movement = state.movimentacoes.find((entry) => entry.id === id);
if (!movement) return;
if (movement.operacao === "entrada" &&
getItemBalance(movement.itemId) - Number(movement.quantidade) < 0) {
showToast("Não é possível excluir: há saídas que dependem desta entrada.");
return;
}
if (!window.confirm("Excluir esta movimentação de madeira?")) return;

const movements = state.movimentacoes.filter((entry) => entry.id !== id);
if (!saveState({ ...state, movimentacoes: movements })) return;
state.movimentacoes = movements;
renderDashboard();
renderMovements();
showToast("Movimentação excluída.");
}

function deleteFinancialEntry(id) {
const entry = state.lancamentosFinanceiros.find((item) => item.id === id);
if (!entry) return;
if (entry.operacao === "entrada" &&
getCashBalanceInCents() - Math.round(Number(entry.valor) * 100) < 0) {
showToast("Não é possível excluir: há pagamentos que dependem deste valor.");
return;
}
if (!window.confirm("Excluir este lançamento financeiro?")) return;

const entries = state.lancamentosFinanceiros.filter((item) => item.id !== id);
if (!saveState({ ...state, lancamentosFinanceiros: entries })) return;
state.lancamentosFinanceiros = entries;
renderFinancialEntries();
showToast("Lançamento financeiro excluído.");
}

document.getElementById("form-movimentacao").addEventListener("submit", (event) => {
event.preventDefault();
const operacao = document.getElementById("mov-tipo-operacao").value;
const itemId = document.getElementById("mov-item").value;
const quantidade = Number(document.getElementById("mov-quantidade").value);
if (!Number.isFinite(quantidade) || quantidade <= 0) {
showToast("Informe uma quantidade maior que zero.");
return;
}

if (operacao === "saida") {
const disponivel = getItemBalance(itemId);
if (quantidade > disponivel) {
const item = getInventoryItem(itemId);
showToast(`Estoque insuficiente. Disponível: ${formatQuantity(disponivel)} ${item ? item.unidade : ""}.`);
return;
}
}

const movement = {
id: createEntryId("madeira"),
operacao,
itemId,
quantidade,
data: document.getElementById("mov-data").value,
observacao: document.getElementById("mov-observacao").value.trim()
};
const movements = [movement, ...state.movimentacoes];
if (!saveState({ ...state, movimentacoes: movements })) return;
state.movimentacoes = movements;
event.currentTarget.reset();
document.getElementById("mov-data").value = getTodayISO();
updateMovementUnitHint();
renderDashboard();
renderMovements();
showToast(operacao === "entrada" ? "Entrada no estoque registrada." : "Saída do estoque registrada.");
});

document.getElementById("mov-item").addEventListener("change", updateMovementUnitHint);

document.getElementById("form-valor").addEventListener("submit", (event) => {
event.preventDefault();
const operacao = document.getElementById("valor-operacao").value;
const valor = Math.round(Number(document.getElementById("valor-quantia").value) * 100) / 100;
if (!Number.isFinite(valor) || valor <= 0) {
showToast("Informe um valor maior que R$ 0,00.");
return;
}

const valorEmCentavos = Math.round(valor * 100);
if (operacao === "saida" && valorEmCentavos > getCashBalanceInCents()) {
showToast(`Saldo insuficiente. Disponível: ${formatCurrency(getCashBalanceInCents() / 100)}.`);
return;
}

const entry = {
id: createEntryId("valor"),
operacao,
valor,
data: document.getElementById("valor-data").value,
descricao: document.getElementById("valor-descricao").value.trim()
};
const entries = [entry, ...state.lancamentosFinanceiros];
if (!saveState({ ...state, lancamentosFinanceiros: entries })) return;
state.lancamentosFinanceiros = entries;
event.currentTarget.reset();
document.getElementById("valor-data").value = getTodayISO();
renderFinancialEntries();
showToast(operacao === "entrada" ? "Valor recebido registrado." : "Pagamento registrado.");
});

// Filters
["filter-cliente", "filter-tipo", "filter-data"].forEach((id) => {
document.getElementById(id).addEventListener("change", renderTable);
});

document.getElementById("btn-clear-filters").addEventListener("click", () => {
document.getElementById("filter-cliente").value = "";
document.getElementById("filter-tipo").value = "";
document.getElementById("filter-data").value = "";
renderTable();
});

// Export CSV (Excel BR format with ;)
document.getElementById("btn-export-csv").addEventListener("click", () => {
const rows = getFilteredRecords();
if (rows.length === 0) {
showToast("Não há registros para exportar.");
return;
}

const header = [
"Data de chegada da madeira",
"Tempo desde a chegada",
"Data da conferência diária",
"Cliente",
"Tipo de Item",
"Medida",
"Quantidade de Pacotes",
"Unidades por Pacote",
"Quantidade Total de Unidades",
"Volume Total (m³)"
];

const csvLines = [header.join(";")];
rows.forEach((r) => {
csvLines.push([
formatDateBR(r.dataRecebimento),
formatStorageDuration(r.dataRecebimento),
formatDateBR(r.dataConferencia),
`"${String(r.cliente).replace(/"/g, '""')}"`,
`"${String(getConferenceTypeLabel(r)).replace(/"/g, '""')}"`,
`"${String(r.medida).replace(/"/g, '""')}"`,
r.qtdPacotes,
r.qtdPorPacote,
r.qtdTotalContada,
formatVolumeM3(r.medida, r.qtdTotalContada)
].join(";"));
});

const bom = "\uFEFF";
const blob = new Blob([bom + csvLines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
downloadBlob(blob, `conferencia_madeiras_${getTodayISO()}.csv`);
showToast("Planilha CSV gerada para o Excel!");
});

// Backup & Restore JSON
document.getElementById("btn-export-json").addEventListener("click", () => {
const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
downloadBlob(blob, `backup_conferencia_${getTodayISO()}.json`);
showToast("Backup JSON baixado!");
});

document.getElementById("input-import-json").addEventListener("change", (e) => {
const file = e.target.files[0];
if (!file) return;
if (!window.confirm("Restaurar este backup substituirá os dados atuais. Deseja continuar?")) {
e.target.value = "";
return;
}

const reader = new FileReader();
reader.onload = () => {
try {
const imported = normalizeState(JSON.parse(reader.result), state);
if (!saveState(imported)) return;
state = imported;
renderSelects();
renderStandardLists();
renderTable();
renderBoxHistory();
document.getElementById("mov-data").value = getTodayISO();
document.getElementById("valor-data").value = getTodayISO();
renderDashboard();
renderMovements();
renderFinancialEntries();
showToast("Backup restaurado com sucesso!");
} catch (error) {
console.error("Falha ao restaurar o backup.", error);
showToast("Arquivo de backup inválido ou corrompido.");
}
};
reader.onerror = () => {
console.error("Não foi possível ler o arquivo de backup.", reader.error);
showToast("Não foi possível ler o arquivo selecionado.");
};
reader.readAsText(file);
e.target.value = "";
});

function downloadBlob(blob, filename) {
const url = URL.createObjectURL(blob);
const a = document.createElement("a");
a.href = url;
a.download = filename;
document.body.appendChild(a);
a.click();
a.remove();
setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Register Service Worker for offline PWA
if ("serviceWorker" in navigator) {
window.addEventListener("load", () => {
navigator.serviceWorker.register("./sw.js").catch((error) => {
console.error("Não foi possível ativar o modo offline.", error);
showToast("Modo offline indisponível. Abra pelo endereço HTTPS ou localhost.");
});
});
}

// Init
document.getElementById("input-data").value = getTodayISO();
document.getElementById("input-data-recebimento").max = getTodayISO();
document.getElementById("mov-data").value = getTodayISO();
document.getElementById("valor-data").value = getTodayISO();
renderSelects();
renderStandardLists();
renderTable();
renderBoxHistory();
renderDashboard();
renderMovements();
renderFinancialEntries();
initializeSyncControls();
