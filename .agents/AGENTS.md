# Ponytail Developer Ruleset

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
