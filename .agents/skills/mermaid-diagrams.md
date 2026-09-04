# Mermaid Diagrams — Agent Skill

Use when creating or editing Mermaid diagrams in `docs-site/` documentation files.

## Setup

DeLaClaw's doc-site uses Docsify + Mermaid v10 (CDN). The rendering hook in `docs-site/index.html` converts ` ```mermaid ` fenced blocks into `<div class="mermaid">` and calls `mermaid.run()` after each page load. Theme: `neutral`. No CLI or build step — diagrams render client-side.

## Syntax

Use ` ```mermaid ` fenced code blocks in any `docs-site/*.md` file.

### Diagram type selection

| Need | Type | Declaration |
|------|------|-------------|
| Module hierarchy, data flow | Flowchart | `flowchart TD` / `flowchart LR` |
| Time-based interactions, message passing | Sequence | `sequenceDiagram` |
| Object relationships | Class | `classDiagram` |
| Database schemas | ER | `erDiagram` |
| State machines, lifecycles | State | `stateDiagram-v2` |

Flowcharts and sequence diagrams cover most DeLaClaw doc needs.

### Flowchart essentials

```
flowchart TD
    A[Rectangle]
    B(Rounded)
    C{Diamond / decision}
    D([Stadium])

    A --> B
    B -->|label| C
    C -.-> D
    A ==> D

    subgraph SG["Group title"]
        direction TB
        E[Node E]
        F[Node F]
    end
```

- Direction: `TD` (top-down), `LR` (left-right), `RL`, `BT`
- Edges: `-->` arrow, `---` line, `-.->` dotted, `==>` thick, `-->|label|` labeled
- Subgraphs require an ID: `subgraph ID["Title"]` — not just `subgraph "Title"`
- Line breaks in labels: `<br/>` inside double-quoted labels

### Sequence diagram essentials

```
sequenceDiagram
    participant A as Alice
    participant B as Bob

    A->>B: Solid arrow
    B-->>A: Dotted arrow
    A-)B: Async

    Note right of B: Annotation
    Note over A,B: Spanning note

    alt Condition
        A->>B: Path 1
    else Other
        A->>B: Path 2
    end

    loop Every 30s
        B->>A: Poll
    end
```

- `Note` keyword works **only** in `sequenceDiagram` — never in flowcharts
- Blocks: `alt`/`else`, `opt`, `par`, `loop`, `rect` — all closed with `end`

## Critical rules

### 1. Reserved keywords — never use as node IDs

These are parsed as Mermaid directives, not node definitions:

`style`, `class`, `click`, `callback`, `link`, `linkStyle`, `classDef`, `default`, `subgraph`, `end`, `graph`, `flowchart`

Use a descriptive alias instead:

```
%% WRONG — "style" is a directive keyword
style["style.css"]

%% RIGHT
cssFile["style.css"]
```

Lowercase `end` also breaks flowcharts. Use `End` or `END` as a node ID.

### 2. Special characters in labels

Problem characters: `:`, `()`, `[]`, `{}`, `@`, `;`, `,`

**Fix:** wrap the label in double quotes.

```
%% WRONG
A[Function: process()]

%% RIGHT
A["Function: process()"]
```

Alternative: HTML entities (`&#58;` for `:`, `&#40;` / `&#41;` for parens, `&#91;` / `&#93;` for brackets).

### 3. Subgraph syntax

Always provide an ID before the quoted title:

```
%% WRONG
subgraph "My Title"

%% RIGHT
subgraph myGroup["My Title"]
```

### 4. Edge-start letters "o" and "x"

`o` and `x` at the start of a node ID after `---` create circle/cross edge decorations. Add a space or rename the node.

```
%% WRONG — creates circle edge
A --- oB

%% RIGHT
A --- OB
```

## Validation checklist

Before committing a Mermaid diagram:

- [ ] No reserved keywords as node IDs
- [ ] Special characters in labels wrapped in double quotes
- [ ] All `subgraph` blocks have an ID and a closing `end`
- [ ] `Note` used only inside `sequenceDiagram`
- [ ] No lowercase `end` as a node name
- [ ] No `o` or `x` immediately after `---`
- [ ] All node IDs unique across the diagram
- [ ] Test at [mermaid.live](https://mermaid.live) if unsure

## Project conventions

- Diagrams live in `docs-site/` markdown files only (not in AGENTS.md, README.md, or contracts)
- Use `flowchart` (not the `graph` alias) for consistency with existing diagrams
- Keep diagrams under ~15 nodes — split large flows into multiple diagrams
- Use subgraphs for logical grouping when a diagram has 2+ distinct phases
- `<br/>` for multi-line labels inside double-quoted strings
- Existing diagrams: `architecture.md` (module tree), `backends.md` (per-backend data flows), `sync-architecture.md` (Drive + Calendar sync flows)
