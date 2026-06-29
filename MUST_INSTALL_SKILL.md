# Must Install AI Agent Skill: Ponytail

This document explains why you **must** install the **Ponytail** skill for your AI agent (like Claude Code, GitHub Copilot CLI, Cursor, or Windsurf) before building the project, and provides the exact prompts/commands to install it globally.

---

## What is the Ponytail Skill?
**Ponytail** (`https://github.com/DietrichGebert/ponytail`) acts as a "lazy but extremely efficient senior developer" ruleset for your AI coding assistant. 

It prevents the AI from writing bloated, over-engineered, or redundant code. It forces the AI to check:
1. **YAGNI**: Does this feature actually need to exist?
2. **Reuse**: Does it already exist in the codebase?
3. **Native solutions**: Can standard libraries, HTML, or CSS handle it natively?
4. **Minimalism**: Can it be written in fewer lines?

*Note: Ponytail never compromises on safety, security, input validation, or error handling—it only removes unnecessary clutter.*

---

## How to Install It Globally

Depending on the AI tool you are using to code this project, run the corresponding command or paste the prompt below.

### 1. Claude Code
If you are using **Claude Code**, run this command directly in your terminal to install the skill:
```bash
/plugin marketplace add DietrichGebert/ponytail
```
Then run:
```bash
/plugin install ponytail@ponytail
```
*(Once installed, open `/hooks` in Claude Code to trust and activate the lifecycle hooks).*

### 2. GitHub Copilot CLI
If you are using **Copilot CLI**, run:
```bash
copilot plugin marketplace add DietrichGebert/ponytail
```
Then run:
```bash
copilot plugin install ponytail@ponytail
```

### 3. Gemini CLI / Google AI CLI
If you are using the **Gemini CLI**, run:
```bash
gemini extensions install https://github.com/DietrichGebert/ponytail
```

### 4. Custom Agents (Cursor, Windsurf, or System Prompts)
If you are using a chat-based assistant like **Cursor** or **Windsurf**, copy and paste this prompt directly into your agent's system prompt or global instructions (e.g., your `.cursorrules` or `.windsurfrules` file):

```text
Please adopt the DietrichGebert/ponytail developer ruleset:
- Climb the decision ladder before writing any code:
  1. Does this code/feature need to exist at all? (YAGNI)
  2. Is there already a similar solution in the codebase?
  3. Can the standard library solve it?
  4. Does the platform/browser support it natively?
  5. Can a currently installed dependency solve it?
  6. Can it be written in a single line?
- Prioritize minimalism, clean structures, and native APIs.
- Never remove security checks, error handling, or input validation.
```
