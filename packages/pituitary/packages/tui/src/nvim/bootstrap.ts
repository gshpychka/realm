import { palette, theme } from "../theme.ts";

/** pituitary's colours for the highlight groups the draft can show: `:help highlight-groups`. */
export const HIGHLIGHTS: Record<string, Record<string, string | boolean>> = {
  Normal: { fg: theme.assistant },
  Visual: { bg: palette.selection },
  MatchParen: { bg: palette.selection, bold: true },
  NonText: { fg: theme.dim },
  SpecialKey: { fg: palette.muted },
  Folded: { fg: theme.dim },
  PiPlaceholder: { fg: theme.dim },
  PiImage: { fg: theme.image, bg: theme.imageTint },
  PiImageEdge: { fg: theme.imageTint },
  PiSkill: { fg: theme.skill, bg: theme.skillTint, bold: true },
};

/**
 * Lua that makes a fresh nvim the draft's editor, run with the channel to report on, the
 * highlight groups to draw in, and the image chip. It defines `pi_draft`, the calls the engine
 * makes, and reports the draft as a `draft` notification whenever it changes.
 */
export const BOOTSTRAP = `
local channel, highlights, chip = ...
vim.o.swapfile = false
vim.o.undofile = false
vim.o.shada = ""
vim.o.more = false
vim.o.clipboard = ""

-- The window is the whole screen: no status, tab, or ruler line takes a row of it.
vim.o.laststatus = 0
vim.o.showtabline = 0
vim.o.ruler = false
vim.o.showmode = false
vim.o.showcmd = false
-- Long lines wrap between words, and the view scrolls through them a screen row at a time.
vim.o.linebreak = true
vim.o.smoothscroll = true
-- The command line that would clear a search's highlight is closed.
vim.o.hlsearch = false
-- The draft has no room below it for a menu: a completion cycles through its matches in place.
vim.o.completeopt = ""
-- A row past the buffer's end shows only while the cursor stands on it, after a line that fills
-- its last row, and shows blank.
vim.opt.fillchars:append({ eob = " " })
vim.o.guicursor = "n-v-o-sm:block,i-c-ci-ve:ver25,r-cr:hor20"
for group, spec in pairs(highlights) do
  vim.api.nvim_set_hl(0, group, spec)
end

local seq = 0
local queued = false

local function u16(line, byte)
  return vim.str_utfindex(line, "utf-16", math.min(byte, #line), false)
end

local function state()
  local lines = vim.api.nvim_buf_get_lines(0, 0, -1, false)
  local cursor = vim.api.nvim_win_get_cursor(0)
  local view = vim.fn.winsaveview()
  -- The cursor's screen row in the whole draft: the rows scrolled above the window, then its row in it.
  local above = vim.api.nvim_win_text_height(0, { end_row = view.topline - 1, end_vcol = view.skipcol }).all
  local row = above + vim.fn.winline() - 1
  return {
    lines = lines,
    row = cursor[1] - 1,
    col = u16(lines[cursor[1]] or "", cursor[2]),
    mode = vim.api.nvim_get_mode().mode,
    onFirstRow = row == 0,
    onLastRow = row >= vim.api.nvim_win_text_height(0, {}).all - 1,
    seq = seq,
  }
end

local function schedule()
  if queued then return end
  queued = true
  vim.schedule(function()
    queued = false
    vim.rpcnotify(channel, "draft", state())
  end)
end

-- A resize wraps the draft afresh, which moves the cursor among its rows.
vim.api.nvim_create_autocmd({
  "TextChanged", "TextChangedI", "TextChangedP", "CursorMoved", "CursorMovedI",
  "ModeChanged", "CmdlineEnter", "CmdlineChanged", "CmdlineLeave", "VimResized",
}, { callback = schedule })

-- An empty draft shows a placeholder while inserting. The autocmds run before nvim redraws, so
-- the placeholder comes and goes in the same frame as the text.
local placeholder = { text = "", ns = vim.api.nvim_create_namespace("pi_placeholder") }

local function mark_placeholder()
  vim.api.nvim_buf_clear_namespace(0, placeholder.ns, 0, -1)
  local lines = vim.api.nvim_buf_get_lines(0, 0, 2, false)
  if #lines == 1 and lines[1] == "" and vim.api.nvim_get_mode().mode:sub(1, 1) == "i" then
    vim.api.nvim_buf_set_extmark(0, placeholder.ns, 0, 0, {
      virt_text = { { placeholder.text, "PiPlaceholder" } },
      virt_text_pos = "overlay",
    })
  end
end

vim.api.nvim_create_autocmd(
  { "TextChanged", "TextChangedI", "TextChangedP", "ModeChanged" },
  { callback = mark_placeholder }
)

-- An image is one character from U+100000 on, which takes one cell. A chip stands in its place,
-- naming the image by the order the draft's images first appear in, as the prompt numbers them.
-- The chip's start covers the character's own cell and the rest follows it, so the cursor stands
-- before the chip or after it.
local images = vim.api.nvim_create_namespace("pi_images")

local function mark_images()
  vim.api.nvim_buf_clear_namespace(0, images, 0, -1)
  local numbers, count = {}, 0
  for row, line in ipairs(vim.api.nvim_buf_get_lines(0, 0, -1, false)) do
    local from = 1
    while true do
      -- U+100000 to U+10FFFF in UTF-8
      local first, last = line:find("\\244[\\128-\\143][\\128-\\191][\\128-\\191]", from)
      if not first then break end
      local id = vim.fn.char2nr(line:sub(first, last))
      if not numbers[id] then
        count = count + 1
        numbers[id] = count
      end
      vim.api.nvim_buf_set_extmark(0, images, row - 1, first - 1, {
        virt_text = { { chip.start, "PiImageEdge" } },
        virt_text_pos = "overlay",
      })
      -- Text typed straight after the chip goes after the rest of it.
      vim.api.nvim_buf_set_extmark(0, images, row - 1, last, {
        virt_text = { { chip.label .. numbers[id], "PiImage" }, { chip.stop, "PiImageEdge" } },
        virt_text_pos = "inline",
        right_gravity = false,
      })
      from = last + 1
    end
  end
end

vim.api.nvim_create_autocmd({ "TextChanged", "TextChangedI", "TextChangedP" }, { callback = mark_images })

-- A leading /skill:<name> naming a skill Pi has loaded is the command Pi expands into the
-- skill's instructions, so it shows as a chip; its text stays as typed. Pi reads the name up to
-- the first space, so a name another line follows straight after loads nothing and shows plain.
local skill = { names = {}, ns = vim.api.nvim_create_namespace("pi_skill") }

local function mark_skill()
  vim.api.nvim_buf_clear_namespace(0, skill.ns, 0, -1)
  local lines = vim.api.nvim_buf_get_lines(0, 0, -1, false)
  local name, after = (lines[1] or ""):match("^/skill:([^%s]+)(.?)")
  if name and skill.names[name] and (after == " " or (after == "" and #lines == 1)) then
    vim.api.nvim_buf_set_extmark(0, skill.ns, 0, 0, { end_col = #"/skill:" + #name, hl_group = "PiSkill" })
  end
end

vim.api.nvim_create_autocmd({ "TextChanged", "TextChangedI", "TextChangedP" }, { callback = mark_skill })

-- startinsert takes effect only once nvim next reads input, so a request can land in
-- between; a key enters insert mode in order with the requests after it.
local function insert(at_end)
  vim.api.nvim_feedkeys(at_end and "A" or "i", "n", false)
end

local function replace(lines, row, col)
  vim.api.nvim_buf_set_lines(0, 0, -1, false, lines)
  mark_images()
  mark_skill()
  local line = lines[row + 1] or ""
  local byte = vim.str_byteindex(line, "utf-16", math.min(col, vim.str_utfindex(line, "utf-16")), false)
  vim.api.nvim_win_set_cursor(0, { row + 1, byte })
  if vim.api.nvim_get_mode().mode ~= "i" then
    insert(byte >= #line)
  end
  seq = seq + 1
  schedule()
end

_G.pi_draft = {
  state = state,
  set = replace,
  take = function()
    local text = table.concat(vim.api.nvim_buf_get_lines(0, 0, -1, false), "\\n")
    replace({ "" }, 0, 0)
    return text
  end,
  placeholder = function(text)
    placeholder.text = text
    mark_placeholder()
  end,
  skills = function(names)
    skill.names = {}
    for _, name in ipairs(names) do skill.names[name] = true end
    mark_skill()
  end,
}

-- The draft is one buffer in one window: keys that open the command line, another file,
-- a window, an external program, or leave nvim have nowhere to go. A mapping never
-- applies to a character argument, so f/, t:, and r: keep their meaning.
local closed = {
  n = { ":", "?", "q:", "q/", "q?", "Q", "gQ", "!", '"=', "K", "ZZ", "ZQ", "<C-z>", "gx", "gf", "gF", "<C-w>", "<C-^>", "<C-]>" },
  x = { ":", "/", "?", "Q", "gQ", "!", '"=', "K", "<C-z>", "gx", "gf", "gF", "<C-w>", "<C-]>" },
  i = { "<C-r>=", "<C-r><C-r>=", "<C-r><C-o>=", "<C-r><C-p>=" },
}
for mode, keys in pairs(closed) do
  for _, key in ipairs(keys) do vim.keymap.set(mode, key, "<Nop>") end
end
-- An operator waiting on a motion that would open the command line gives up instead.
for _, key in ipairs({ ":", "/", "?" }) do vim.keymap.set("o", key, "<Esc>") end
-- A search in an empty draft is the operator reaching for the command palette.
vim.keymap.set("n", "/", function()
  local lines = vim.api.nvim_buf_get_lines(0, 0, -1, false)
  return (#lines == 1 and lines[1] == "") and "i/" or ""
end, { expr = true })

-- The arrows walk the rows the draft shows, and j and k its lines, as in vim. In insert
-- mode, ctrl+\\ ctrl+o runs the motion from where the cursor stands, the end of a line included.
vim.keymap.set({ "n", "x" }, "<Up>", "gk")
vim.keymap.set({ "n", "x" }, "<Down>", "gj")
vim.keymap.set("i", "<Up>", "<C-Bslash><C-o>gk")
vim.keymap.set("i", "<Down>", "<C-Bslash><C-o>gj")

insert(false)
schedule()
`;
