/**
 * The rest of the `ide` API: exec, panes, sessions, timers, json, store and
 * notify. Runs after SANDBOX_PRELUDE and ACTIONS_PRELUDE and reaches them
 * only through `__ide_internal`. Daemon-side work goes through the private
 * host functions in `__ide_internal.host` (see ../host-calls.ts).
 */
export const MAX_TIMERS_PER_PLUGIN = 64;
export const MIN_REPEAT_MS = 250;

export const HOST_API_PRELUDE = String.raw`
local internal = __ide_internal
local timer_start, timer_cancel, json_decode_raw = __ide_timer_start, __ide_timer_cancel, __ide_json_decode
__ide_timer_start, __ide_timer_cancel, __ide_json_decode = nil, nil, nil

local ide, host, arm, runners = internal.ide, internal.host, internal.arm, internal.runners
local json_encode = internal.json_encode
local raw_error, raw_type, raw_pairs, raw_ipairs, raw_tostring, raw_setmetatable =
  error, type, pairs, ipairs, tostring, setmetatable
local m_type = math.type
local co_running = coroutine.running
local MAX_TIMERS, MIN_REPEAT = ${MAX_TIMERS_PER_PLUGIN}, ${MIN_REPEAT_MS}

local function fail(message) raw_error("E_INVALID: " .. message, 3) end
local function call(name, ...)
  local fn = host[name]
  if not fn then raw_error("E_UNAVAILABLE: this tmux-ide has no " .. name, 3) end
  return fn(...)
end

----------------------------------------------------------------------- exec

ide.exec = function(spec)
  if raw_type(spec) ~= "table" then fail("ide.exec expects a table like { cmd = 'git', args = {...} }") end
  local request = {}
  for _, key in raw_ipairs({ "cmd", "cwd", "stdin", "timeout_ms", "context", "shell" }) do
    request[key] = spec[key]
  end
  if spec.args ~= nil then
    if raw_type(spec.args) ~= "table" then fail("ide.exec args must be a list of strings") end
    local args = {}
    for i, value in raw_ipairs(spec.args) do args[i] = raw_tostring(value) end
    request.args = args
  end
  if spec.env ~= nil then
    if raw_type(spec.env) ~= "table" then fail("ide.exec env must be a table of strings") end
    local env = {}
    for key, value in raw_pairs(spec.env) do env[raw_tostring(key)] = raw_tostring(value) end
    request.env = env
  end
  return call("_exec", request)
end

-------------------------------------------------------------------- notify

ide.notify = function(text, opts)
  local level = raw_type(opts) == "table" and opts.level or nil
  return call("_notify", raw_tostring(text), level)
end

---------------------------------------------------------------------- json

ide.json = {
  encode = function(value) return json_encode(value) end,
  decode = function(text)
    if raw_type(text) ~= "string" then fail("ide.json.decode expects a string") end
    return json_decode_raw(text)
  end,
}

--------------------------------------------------------------------- store

ide.store = {
  get = function(key) return call("_store_get", key) end,
  set = function(key, value) return call("_store_set", key, value) end,
  delete = function(key) return call("_store_set", key, nil) end,
  keys = function() return call("_store_keys") end,
}

-------------------------------------------------------------------- timers

local timers = {}
local timer_count = 0
local next_timer = 0

local function cancel(id)
  if timers[id] == nil then return false end
  timers[id] = nil
  timer_count = timer_count - 1
  timer_cancel(id)
  return true
end

local function start(ms, fn, repeating)
  if raw_type(fn) ~= "function" then fail("timer callback must be a function") end
  if raw_type(ms) ~= "number" or ms ~= ms or ms < 0 or ms > 86400000 then
    fail("timer delay must be a number of milliseconds")
  end
  if repeating and ms < MIN_REPEAT then fail("ide.timer.every needs at least " .. MIN_REPEAT .. " ms") end
  if timer_count >= MAX_TIMERS then fail("a plugin may have at most " .. MAX_TIMERS .. " timers") end
  next_timer = next_timer + 1
  local id = next_timer
  timers[id] = { fn = fn, repeating = repeating }
  timer_count = timer_count + 1
  timer_start(id, math.floor(ms), repeating)
  return { id = id, cancel = function() return cancel(id) end }
end

ide.timer = {
  after = function(ms, fn) return start(ms, fn, false) end,
  every = function(ms, fn) return start(ms, fn, true) end,
}

internal.run_timer = function(id)
  runners[co_running()] = true
  arm()
  local timer = timers[id]
  if not timer then return "[]" end
  if not timer.repeating then
    timers[id] = nil
    timer_count = timer_count - 1
  end
  timer.fn()
  return "[]"
end

-------------------------------------------------- panes, windows, sessions

local Pane = {}
Pane.__index = Pane

local function pane_object(raw)
  local endpoint = raw.endpoint
  return raw_setmetatable({
    id = endpoint.semanticPaneId,
    workspace = endpoint.workspaceName,
    session = raw.session,
    title = raw.title,
    endpoint = endpoint,
  }, Pane)
end

local function action(name, input) return call("_action", name, input) end

function Pane:read() return call("_pane_read", self.endpoint) end
function Pane:send(text, opts)
  if raw_type(text) ~= "string" or #text == 0 then fail("pane:send expects text") end
  local enter = not (raw_type(opts) == "table" and opts.enter == false)
  return call("_pane_send", self.endpoint, text, enter)
end
function Pane:split(opts)
  opts = opts or {}
  local direction = opts.dir or "right"
  if direction ~= "right" and direction ~= "down" then fail("pane:split dir must be 'right' or 'down'") end
  return action("workspace.window.split", {
    workspaceName = self.workspace, semanticPaneId = self.id,
    direction = direction, displayTitle = opts.title,
  })
end
function Pane:zoom(on)
  local desired = on == nil and "toggle" or (on and "zoomed" or "unzoomed")
  return action("workspace.pane.zoom.toggle", {
    workspaceName = self.workspace, semanticPaneId = self.id, desired = desired,
  })
end
function Pane:focus()
  return action("workspace.pane.select", { workspaceName = self.workspace, semanticPaneId = self.id })
end
function Pane:rename(name)
  return action("workspace.rename", {
    workspaceName = self.workspace, scope = "pane", semanticPaneId = self.id, name = name,
  })
end
function Pane:kill()
  return action("workspace.pane.kill", { workspaceName = self.workspace, semanticPaneId = self.id })
end
function Pane:rename_window(name)
  return action("workspace.rename", {
    workspaceName = self.workspace, scope = "window",
    target = { by = "pane", semanticPaneId = self.id }, name = name,
  })
end
function Pane:kill_window()
  return action("workspace.window.kill", {
    workspaceName = self.workspace, target = { by = "pane", semanticPaneId = self.id },
  })
end

ide.panes = function(filter)
  local out = {}
  for _, raw in raw_ipairs(call("_panes")) do
    local pane = pane_object(raw)
    if raw_type(filter) ~= "table"
      or ((filter.session == nil or filter.session == pane.session)
        and (filter.workspace == nil or filter.workspace == pane.workspace)) then
      out[#out + 1] = pane
    end
  end
  return out
end

ide.session = function(workspace)
  if raw_type(workspace) ~= "string" or #workspace == 0 then fail("ide.session expects a workspace name") end
  return {
    workspace = workspace,
    rename = function(_, name)
      return action("workspace.rename", { workspaceName = workspace, scope = "session", name = name })
    end,
    kill = function() return action("workspace.session.kill", { workspaceName = workspace }) end,
  }
end

for _, feature in raw_ipairs({ "exec", "panes", "timers", "json", "store", "notify" }) do
  internal.features[feature] = true
end
`;
