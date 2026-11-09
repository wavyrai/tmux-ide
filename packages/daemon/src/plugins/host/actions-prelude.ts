/**
 * `ide.action`: named functions a plugin offers to the command palette, key
 * bindings and `tmux-ide action run`. Runs after SANDBOX_PRELUDE and reaches
 * it only through `__ide_internal`.
 *
 * The plugin keeps its callbacks; the host learns only plain descriptors. A
 * change calls `__ide_actions_changed()`, and when the callback finishes the
 * host reads the list once through `__ide_internal.actions_json()`.
 * Arguments are checked here, in Lua, so `pattern` is a Lua pattern.
 */
export const MAX_ACTIONS_PER_PLUGIN = 200;
export const MAX_PARAMS_PER_ACTION = 32;
/** Local action id length, so `plugin.<name>.<id>` fits the catalog's 160. */
export const MAX_LOCAL_ACTION_ID = 80;

export const ACTIONS_PRELUDE = String.raw`
local internal = __ide_internal
local mark_dirty = __ide_actions_changed
__ide_actions_changed = nil

local arm, runners, ide, json_encode = internal.arm, internal.runners, internal.ide, internal.json_encode
local raw_error, raw_type, raw_pairs, raw_ipairs, raw_tostring =
  error, type, pairs, ipairs, tostring
local s_match, s_find = string.match, string.find
local co_running = coroutine.running
local MAX_ACTIONS = ${MAX_ACTIONS_PER_PLUGIN}
local MAX_PARAMS = ${MAX_PARAMS_PER_ACTION}
local MAX_ID = ${MAX_LOCAL_ACTION_ID}

local actions = {}
local order = {}

local PARAM_TYPES = { string = true, text = true, number = true, boolean = true, choice = true }

local function fail(message) raw_error("E_INVALID: " .. message, 3) end

-- Plain text only: no C0/DEL controls, C1 controls, bidi or zero-width
-- format characters, U+FEFF, soft hyphens or U+2028/U+2029; the catalog
-- schema refuses the rarer format characters at publish. They
-- would reach terminals that show this text.
local function unsafe(text)
  return s_find(text, "[%c\127]") ~= nil
    or s_find(text, "\194[\128-\159]") ~= nil
    or s_find(text, "\216\156") ~= nil
    or s_find(text, "\226\128[\139-\143\168-\174]") ~= nil
    or s_find(text, "\226\129[\160-\164\166-\175]") ~= nil
    or s_find(text, "\239\187\191") ~= nil
    or s_find(text, "\194\173") ~= nil
end

local function check_string(value, what, max, optional)
  if value == nil and optional then return nil end
  if raw_type(value) ~= "string" or #value == 0 or #value > max then
    fail(what .. " must be a string of 1 to " .. max .. " characters")
  end
  if unsafe(value) then fail(what .. " must be plain text: no control characters or newlines") end
  return value
end

local function normalize_choices(list, where)
  if raw_type(list) ~= "table" then fail(where .. " must return a list") end
  local out = {}
  for i, item in raw_ipairs(list) do
    if i > 500 then fail(where .. " has more than 500 choices") end
    if raw_type(item) == "string" then
      out[i] = { value = item, label = item }
    elseif raw_type(item) == "table" and raw_type(item.value) == "string" then
      out[i] = { value = item.value, label = raw_type(item.label) == "string" and item.label or item.value }
    else
      out[i] = false
    end
    if not out[i] or unsafe(out[i].value) or unsafe(out[i].label) or #out[i].label == 0 then
      fail(where .. " entries must be strings or { value, label } tables")
    end
  end
  return out
end

local function normalize_param(param, index)
  if raw_type(param) ~= "table" then fail("params[" .. index .. "] must be a table") end
  local name = param.name
  if raw_type(name) ~= "string" or not s_match(name, "^[a-z_][a-z0-9_]*$") or #name > 64 then
    fail("params[" .. index .. "].name must be lowercase letters, digits and _")
  end
  local kind = param.type or "string"
  if not PARAM_TYPES[kind] then fail("param '" .. name .. "' has unknown type '" .. raw_tostring(kind) .. "'") end
  if param.pattern ~= nil and raw_type(param.pattern) ~= "string" then
    fail("param '" .. name .. "'.pattern must be a Lua pattern string")
  end
  local static_choices, dynamic_choices = nil, false
  if raw_type(param.choices) == "function" then
    dynamic_choices = true
  elseif param.choices ~= nil then
    static_choices = normalize_choices(param.choices, "param '" .. name .. "'.choices")
  end
  if kind == "choice" and not static_choices and not dynamic_choices then
    fail("choice param '" .. name .. "' needs choices")
  end
  local static_default, dynamic_default = nil, false
  if raw_type(param.default) == "function" then
    dynamic_default = true
  elseif param.default ~= nil then
    local t = raw_type(param.default)
    if t ~= "string" and t ~= "number" and t ~= "boolean" then
      fail("param '" .. name .. "'.default must be a string, number, boolean or function")
    end
    if t == "string" and unsafe(param.default) then
      fail("param '" .. name .. "'.default must be plain text: no control characters or newlines")
    end
    static_default = param.default
  end
  return {
    name = name,
    type = kind,
    label = check_string(param.label, "param '" .. name .. "'.label", 120, true) or name,
    description = check_string(param.description, "param '" .. name .. "'.description", 500, true),
    required = param.optional ~= true,
    default = static_default,
    dynamicDefault = dynamic_default,
    choices = static_choices,
    dynamicChoices = dynamic_choices,
    -- Kept for checking only; never published.
    pattern = param.pattern,
    choices_fn = dynamic_choices and param.choices or nil,
    default_fn = dynamic_default and param.default or nil,
  }
end

local function valid_id(id)
  if raw_type(id) ~= "string" or #id == 0 or #id > MAX_ID then return false end
  if not s_match(id, "^[a-z]") or s_find(id, "..", 1, true) or s_match(id, "%.$") then return false end
  return s_match(id, "^[a-z0-9.-]+$") ~= nil
end

-- The host asks for the list once a callback finishes, so registering many
-- actions in one load costs one encoding, not one per action.
local function actions_json()
  local list = {}
  for i, id in raw_ipairs(order) do
    local action = actions[id]
    local params = {}
    for j, p in raw_ipairs(action.params) do
      params[j] = {
        name = p.name, type = p.type, label = p.label, description = p.description,
        required = p.required, default = p.default, dynamicDefault = p.dynamicDefault,
        choices = p.choices, dynamicChoices = p.dynamicChoices,
      }
    end
    list[i] = {
      id = id, title = action.title, category = action.category,
      description = action.description, dangerous = action.dangerous, params = params,
    }
  end
  return json_encode(list)
end
internal.actions_json = actions_json

ide.action = {
  register = function(spec)
    if raw_type(spec) ~= "table" then fail("ide.action.register expects a table") end
    local id = spec.id
    if not valid_id(id) then
      fail("action id must be dot-separated parts of lowercase letters, digits and dashes, like 'tasks.new'")
    end
    if raw_type(spec.run) ~= "function" then fail("action '" .. id .. "' needs a run function") end
    local params = {}
    local seen = {}
    if spec.params ~= nil then
      if raw_type(spec.params) ~= "table" then fail("params must be a list") end
      for i, param in raw_ipairs(spec.params) do
        if i > MAX_PARAMS then fail("an action may have at most " .. MAX_PARAMS .. " params") end
        local p = normalize_param(param, i)
        if seen[p.name] then fail("param '" .. p.name .. "' is declared twice") end
        seen[p.name] = true
        params[i] = p
      end
    end
    -- Validate everything before changing anything.
    local record = {
      title = check_string(spec.title, "action '" .. id .. "'.title", 160),
      category = check_string(spec.category, "action '" .. id .. "'.category", 80, true) or "Plugins",
      description = check_string(spec.description, "action '" .. id .. "'.description", 500, true),
      dangerous = spec.dangerous == true,
      params = params,
      run = spec.run,
    }
    if actions[id] == nil then
      if #order >= MAX_ACTIONS then fail("a plugin may register at most " .. MAX_ACTIONS .. " actions") end
      order[#order + 1] = id
    end
    actions[id] = record
    mark_dirty()
  end,
  unregister = function(id)
    if actions[id] == nil then return false end
    actions[id] = nil
    for i, existing in raw_ipairs(order) do
      if existing == id then table.remove(order, i) break end
    end
    mark_dirty()
    return true
  end,
}
internal.features.actions = true

local function check_args(action, args)
  if raw_type(args) ~= "table" then args = {} end
  local known = {}
  for _, p in raw_ipairs(action.params) do known[p.name] = p end
  for name in raw_pairs(args) do
    if not known[name] then raw_error("E_INVALID: unknown argument '" .. raw_tostring(name) .. "'", 0) end
  end
  local clean = {}
  for _, p in raw_ipairs(action.params) do
    local value = args[p.name]
    if value == nil then value = p.default end
    if value == nil then
      if p.required then raw_error("E_INVALID: '" .. p.label .. "' is required", 0) end
    else
      local t = raw_type(value)
      if (p.type == "number" and t ~= "number")
        or (p.type == "boolean" and t ~= "boolean")
        or ((p.type == "string" or p.type == "text" or p.type == "choice") and t ~= "string") then
        raw_error("E_INVALID: '" .. p.label .. "' must be a " .. p.type, 0)
      end
      if p.pattern and not s_match(value, p.pattern) then
        raw_error("E_INVALID: '" .. p.label .. "' does not match " .. p.pattern, 0)
      end
      if p.type == "choice" and p.choices then
        local ok = false
        for _, c in raw_ipairs(p.choices) do if c.value == value then ok = true break end end
        if not ok then raw_error("E_INVALID: '" .. p.label .. "' must be one of its choices", 0) end
      end
      clean[p.name] = value
    end
  end
  return clean
end

local function find(id)
  local action = actions[id]
  if not action then raw_error("E_NOT_FOUND: no action '" .. raw_tostring(id) .. "'", 0) end
  return action
end

internal.invoke_action = function(id, args, context)
  runners[co_running()] = true
  arm()
  local action = find(id)
  local clean = check_args(action, args)
  return json_encode({ action.run(context or {}, clean) })
end

internal.param_options = function(id, name, context)
  runners[co_running()] = true
  arm()
  local action = find(id)
  for _, p in raw_ipairs(action.params) do
    if p.name == name then
      local result = { choices = p.choices, default = p.default }
      if p.choices_fn then
        result.choices = normalize_choices(p.choices_fn(context or {}), "choices for '" .. name .. "'")
      end
      if p.default_fn then
        local value = p.default_fn(context or {})
        local t = raw_type(value)
        if value ~= nil and t ~= "string" and t ~= "number" and t ~= "boolean" then
          raw_error("E_INVALID: default for '" .. name .. "' must be a string, number or boolean", 0)
        end
        if t == "string" and unsafe(value) then
          raw_error("E_INVALID: default for '" .. name .. "' must be plain text", 0)
        end
        result.default = value
      end
      return json_encode(result)
    end
  end
  raw_error("E_NOT_FOUND: action '" .. id .. "' has no param '" .. raw_tostring(name) .. "'", 0)
end
`;
