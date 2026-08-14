# Story: {{STORY_ID}} — {{TITLE}}

<!--
  TEMPLATE — copy to .pi/artifacts/implementation/stories/<story-id>.md
  and fill each section. The story-ready checkpoint validates:
    1. ## Acceptance Criteria exists
    2. ## Implementation Brief exists
    3. ## Definition of Done has - [ ] checkbox items (NOT plain - bullets)
    4. ## Tasks / Subtasks has - [ ] checkbox items (NOT plain - bullets)
  KEEP the - [ ] prefix on every task and DoD item or the checkpoint REJECTS.
-->

**Story ID:** {{STORY_ID}}
**Title:** {{TITLE}}
**Issue:** {{ISSUE_REF}}
**Sprint:** {{SPRINT_NAME}}
**Status:** `planned`
**Created:** {{DATE}}

---

## Story

<!-- select-story step: identify the story from sprint-status.yaml -->

**As a** {{ROLE}}
**I want** {{ACTION}}
**So that** {{OUTCOME}}

### Description

<!-- fetch-source-ticket step: read the Linear ticket or source spec and describe the problem/goal -->

{{DETAILED_DESCRIPTION}}

---

## Acceptance Criteria

<!-- analyze-artifacts step: derive Given/When/Then ACs from the spec/plan.
     Include at least one adversarial AC (what must NOT happen). -->

### AC1 — {{AC_TITLE}}

**Given** {{PRECONDITION}}
**When** {{ACTION}}
**Then** {{EXPECTED_RESULT}}

### AC2 — {{AC_TITLE}}

**Given** {{PRECONDITION}}
**When** {{ACTION}}
**Then** {{EXPECTED_RESULT}}

---

## Invariants / Must Never Happen

<!-- If no invariants apply, write "None identified." -->

- {{INVARIANT_1}}
- {{INVARIANT_2}}

---

## Implementation Brief

<!-- compile-brief step: read every file in scope. For each file touched,
     write an UPDATE or NEW entry with ALL FOUR required fields.
     Missing a field → story rejected. -->

### Summary

{{BRIEF_SUMMARY_OF_ALL_CHANGES}}

### File Entries

#### `{{FILE_PATH}}` — UPDATE

##### Current State

{{WHAT_THE_FILE_LOOKS_LIKE_TODAY — read the full file}}

##### Proposed Change

{{SPECIFIC_CHANGES_TO_FUNCTIONS_TYPES_EXPORTS}}

##### Preservation Constraints

{{WHAT_MUST_NOT_CHANGE}}

##### Downstream Consumers

{{CONSUMER_TABLE_OR "No external consumers"}}

---

## Evidence & Artifacts

<!-- Link workspace evidence: patches, screenshots, debug reports.
     "None — greenfield implementation" is acceptable for new stories. -->

- {{EVIDENCE_LINK_OR "None — implementation not started"}}

---

## Tasks / Subtasks

<!-- CRITICAL: Every item MUST use - [ ] checkbox syntax.
     The story-ready checkpoint REJECTS plain - bullets.
     Add or remove tasks as needed but ALWAYS keep the - [ ] prefix.
     Use RED/GREEN/REFACTOR/VALIDATE task naming for TDD stories. -->

- [ ] **Task 1: RED — {{FAILING_TEST_DESCRIPTION}}**
  - [ ] {{SUBTASK_DETAIL}}
- [ ] **Task 2: GREEN — {{IMPLEMENTATION_DESCRIPTION}}**
  - [ ] {{SUBTASK_DETAIL}}
- [ ] **Task 3: REFACTOR — {{CLEANUP_DESCRIPTION}}**
  - [ ] {{SUBTASK_DETAIL}}
- [ ] **Task 4: VALIDATE — Run full quality gate**
  - [ ] {{VALIDATION_COMMAND}}

---

## Test Plan

<!-- List every test file that must pass, with coverage scope. -->

| Test File | Coverage |
|-----------|----------|
| `{{TEST_FILE_PATH}}` | {{WHAT_IT_COVERS}} |

---

## Definition of Done

<!-- CRITICAL: Every item MUST use - [ ] checkbox syntax.
     The story-ready checkpoint REJECTS plain - bullets. -->

- [ ] All acceptance criteria implemented and tested
- [ ] Targeted and regression tests pass
- [ ] Type checking passes (`npm run check` or equivalent)
- [ ] Lint and formatting pass
- [ ] No public signature changes without documented consumer impact
- [ ] All work committed as focused conventional commits

---

## Dev Agent Record

<!-- Owned by Developer Agent. Scrum Master creates this section empty. -->

---

## File List

<!-- Owned by Developer Agent. Scrum Master creates this section empty. -->

---

## Change Log

<!-- Owned by Developer Agent. Scrum Master creates this section empty. -->

---

## Status

```yaml
status: planned
transitions:
  - "{{DATE}}": planned
```
