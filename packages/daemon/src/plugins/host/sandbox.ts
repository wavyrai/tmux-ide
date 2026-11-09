/**
 * The Lua prelude every plugin state runs before any plugin code.
 *
 * Plugin code never sees the real globals. It runs in `env`, a table built
 * from an allow-list, so nothing outside the list (io, os.execute, debug,
 * package, dofile, loadfile, string.dump) is reachable. The real globals keep
 * one table, `__ide_internal`, which the host's runner threads call into.
 *
 * Deadlines: every runner thread, and every coroutine plugin code creates,
 * gets a count hook that asks the host whether the current callback's budget
 * is spent and, if so, raises `E_TIMEOUT`. `pcall` can catch that error, so
 * the hook keeps raising it on every check until the callback returns; a
 * plugin that catches it in a loop forever is stopped by the host watchdog.
 *
 * Host functions the prelude expects as globals (removed once captured):
 *   __ide_over()                      → boolean, true once the budget is spent
 *   __ide_log(level, message, json?)  → nil
 *   __ide_resolve(kind, name)         → source, display path | nil, error
 *   __ide_info                        → { api, version, plugin, settings_json }
 */
export const HOOK_INSTRUCTION_COUNT = 10_000;

export const TIMEOUT_MESSAGE = "E_TIMEOUT: the callback ran past its time budget";

export const SANDBOX_PRELUDE = String.raw`
local sethook = debug.sethook
local raw_load, raw_pcall, raw_error = load, pcall, error
local raw_type, raw_tostring, raw_select = type, tostring, select
local raw_pairs, raw_ipairs, raw_next = pairs, ipairs, next
local raw_setmetatable, raw_getmetatable = setmetatable, getmetatable
local raw_rawget, raw_rawset, raw_rawequal, raw_rawlen = rawget, rawset, rawequal, rawlen
local co_create, co_wrap = coroutine.create, coroutine.wrap
local s_format, s_byte, s_char, s_gsub, s_match, s_rep, s_sub =
  string.format, string.byte, string.char, string.gsub, string.match, string.rep, string.sub
local t_concat, t_insert, t_sort = table.concat, table.insert, table.sort
local m_floor, m_huge, m_type = math.floor, math.huge, math.type

local co_running, co_yield = coroutine.running, coroutine.yield
local over = __ide_over
local host_log = __ide_log
local host_resolve = __ide_resolve
local host_begin = __ide_begin
local info = __ide_info
__ide_over, __ide_log, __ide_resolve, __ide_begin, __ide_info = nil, nil, nil, nil, nil

-- Runner threads the host started. Host calls yield to the host, so they
-- are only allowed directly on a runner, never inside a plugin coroutine.
local runners = raw_setmetatable({}, { __mode = "k" })

local HOOK_COUNT = ${HOOK_INSTRUCTION_COUNT}
local TIMEOUT = "${TIMEOUT_MESSAGE}"

local function hook()
  if over() then raw_error(TIMEOUT, 0) end
end
local function arm() sethook(hook, "", HOOK_COUNT) end

-- The string metatable's __index is the real string table. Hide the
-- metatable itself so plugins cannot reach or change it.
raw_getmetatable("").__metatable = false
-- ("").dump reaches the real string table: remove dump there too.
string.dump = nil

----------------------------------------------------------------- JSON encode

local function is_array(t)
  local n = 0
  for k in raw_pairs(t) do
    if m_type(k) ~= "integer" or k < 1 then return false end
    if k > n then n = k end
  end
  return true, n
end

local escapes = { ['"'] = '\\"', ['\\'] = '\\\\', ['\b'] = '\\b', ['\f'] = '\\f',
                  ['\n'] = '\\n', ['\r'] = '\\r', ['\t'] = '\\t' }
local function quote(s)
  return '"' .. s_gsub(s, '[%c"\\]', function(c)
    return escapes[c] or s_format("\\u%04x", s_byte(c))
  end) .. '"'
end

local function encode(v, depth, seen)
  local tv = raw_type(v)
  if v == nil then return "null"
  elseif tv == "boolean" then return v and "true" or "false"
  elseif tv == "number" then
    if v ~= v or v == m_huge or v == -m_huge then return "null" end
    if m_type(v) == "integer" then return s_format("%d", v) end
    return s_format("%.17g", v)
  elseif tv == "string" then return quote(v)
  elseif tv == "table" then
    if seen[v] then raw_error("E_INVALID: cannot encode a table that contains itself", 0) end
    if depth > 64 then raw_error("E_INVALID: table nested deeper than 64 levels", 0) end
    seen[v] = true
    local out = {}
    local array, n = is_array(v)
    if array and (n > 0 or raw_next(v) == nil) then
      for i = 1, n do out[i] = encode(v[i], depth + 1, seen) end
      seen[v] = nil
      return "[" .. t_concat(out, ",") .. "]"
    end
    local keys = {}
    for k in raw_pairs(v) do
      local tk = raw_type(k)
      if tk ~= "string" and tk ~= "number" then
        raw_error("E_INVALID: object keys must be strings or numbers", 0)
      end
      keys[#keys + 1] = k
    end
    t_sort(keys, function(a, b) return raw_tostring(a) < raw_tostring(b) end)
    for i, k in raw_ipairs(keys) do
      out[i] = quote(raw_tostring(k)) .. ":" .. encode(v[k], depth + 1, seen)
    end
    seen[v] = nil
    return "{" .. t_concat(out, ",") .. "}"
  else
    return quote("<" .. tv .. ">")
  end
end
local function json_encode(v) return encode(v, 0, {}) end

------------------------------------------------------------- plugin globals

local env = {}

local function copy(t, except)
  local out = {}
  for k, v in raw_pairs(t) do
    if not (except and except[k]) then out[k] = v end
  end
  return out
end

for _, name in raw_ipairs({
  "assert", "error", "ipairs", "next", "pairs", "pcall", "rawequal", "rawget",
  "rawlen", "rawset", "select", "setmetatable", "getmetatable", "tonumber",
  "tostring", "type", "xpcall", "_VERSION",
}) do env[name] = _G[name] end

env.string = copy(string, { dump = true })
env.table = copy(table)
env.math = copy(math)
env.utf8 = copy(utf8)
env.os = { time = os.time, clock = os.clock, date = os.date }

local coroutine_api = copy(coroutine)
coroutine_api.create = function(fn)
  if raw_type(fn) ~= "function" then raw_error("bad argument #1 to 'create' (function expected)", 2) end
  return co_create(function(...) arm() return fn(...) end)
end
coroutine_api.wrap = function(fn)
  if raw_type(fn) ~= "function" then raw_error("bad argument #1 to 'wrap' (function expected)", 2) end
  return co_wrap(function(...) arm() return fn(...) end)
end
env.coroutine = coroutine_api

env.collectgarbage = function(opt)
  if opt == nil or opt == "collect" or opt == "count" or opt == "step" then
    return collectgarbage(opt)
  end
  raw_error("collectgarbage: only 'collect', 'count' and 'step' are allowed", 2)
end

env.load = function(chunk, name, mode, chunk_env)
  if raw_type(chunk) ~= "string" then return nil, "load accepts source text only" end
  if mode ~= nil and mode ~= "t" then return nil, "load accepts source text only" end
  return raw_load(chunk, name, "t", chunk_env or env)
end

----------------------------------------------------------------- ide table

local function stringify_args(...)
  local n = raw_select("#", ...)
  local parts = {}
  for i = 1, n do parts[i] = raw_tostring((raw_select(i, ...))) end
  return t_concat(parts, "\t")
end

local function make_logger(level)
  return function(message, fields)
    local fields_json = nil
    if fields ~= nil then
      if raw_type(fields) ~= "table" then raw_error("E_INVALID: log fields must be a table", 2) end
      fields_json = json_encode(fields)
    end
    host_log(level, raw_tostring(message), fields_json)
  end
end

local features = { log = true, include = true, require = true }

local ide = {
  api = info.api,
  version = info.version,
  plugin = { name = info.plugin },
  settings = info.settings or {},
  log = {
    debug = make_logger("debug"),
    info = make_logger("info"),
    warn = make_logger("warn"),
    error = make_logger("error"),
  },
}
ide.has = function(feature) return features[feature] == true end

local function host_function(name)
  return function(...)
    if not runners[co_running()] then
      raw_error("E_INVALID: ide." .. name .. " cannot be called inside a coroutine", 2)
    end
    host_begin(name, json_encode({ ... }))
    local ok, value = co_yield()
    if not ok then raw_error(value, 2) end
    return value
  end
end

for _, name in raw_ipairs(info.host_functions or {}) do
  local target = ide
  local parts = {}
  for part in string.gmatch(name, "[^.]+") do parts[#parts + 1] = part end
  for i = 1, #parts - 1 do
    target[parts[i]] = target[parts[i]] or {}
    target = target[parts[i]]
  end
  target[parts[#parts]] = host_function(name)
end

env.print = function(...) host_log("info", stringify_args(...), nil) end

local function run_source(kind, name, ...)
  local source, path = host_resolve(kind, name)
  if source == nil then raw_error(path, 0) end
  local fn, err = raw_load(source, "@" .. path, "t", env)
  if not fn then raw_error(err, 0) end
  return fn(...)
end

ide.include = function(file)
  if raw_type(file) ~= "string" then raw_error("E_INVALID: ide.include expects a file name", 2) end
  return run_source("file", file)
end

local loaded = {}
local loading = {}
env.require = function(name)
  if raw_type(name) ~= "string" or not s_match(name, "^[%w_][%w_%-]*[%.%w_%-]*$") then
    raw_error("E_INVALID: bad module name", 2)
  end
  local value = loaded[name]
  if value ~= nil then return value end
  if loading[name] then raw_error("E_INVALID: module '" .. name .. "' requires itself", 2) end
  loading[name] = true
  local ok, result = raw_pcall(run_source, "module", name, name)
  loading[name] = nil
  if not ok then raw_error(result, 0) end
  if result == nil then result = true end
  loaded[name] = result
  return result
end

env.ide = ide
env._G = env

------------------------------------------------------------- host runners

local function pack_results(...)
  local n = raw_select("#", ...)
  local out = {}
  for i = 1, n do out[i] = (raw_select(i, ...)) end
  local parts = {}
  for i = 1, n do parts[i] = encode(out[i], 0, {}) end
  return "[" .. t_concat(parts, ",") .. "]"
end

__ide_internal = {
  -- Run source text as plugin code. Returns the results as JSON text.
  run_source = function(source, chunk_name)
    runners[co_running()] = true
    arm()
    local fn, err = raw_load(source, chunk_name, "t", env)
    if not fn then raw_error(err, 0) end
    return pack_results(fn())
  end,
  json_encode = json_encode,
  -- For the preludes that run after this one (see actions-prelude.ts).
  arm = arm,
  runners = runners,
  ide = ide,
  features = features,
}
`;
