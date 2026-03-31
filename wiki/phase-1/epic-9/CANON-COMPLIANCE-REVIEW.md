# Epic 9: Dashboard API and WebSocket Gateways
## CANON Compliance Review

**Reviewer:** Canon, Project Integrity Guardian
**Date:** 2026-03-29
**Status:** PRE-IMPLEMENTATION REVIEW
**Verdict:** COMPLIANT WITH CRITICAL CONSTRAINTS

---

## Executive Summary

Epic 9 (Dashboard API and WebSocket Gateways) is architecturally sound and CANON-aligned. The epic establishes surface-layer HTTP/WebSocket interfaces for visibility into Sylphie's cognitive state without modifying the five-subsystem architecture.

**Critical assumption:** The Web Module is a **surface transport layer**, not a 6th subsystem. All intelligence remains in the five core subsystems. The Web Module reads from shared stores (WKG, TimescaleDB) and mediates human observation, not cognitive decisions.

This review validates:
- Philosophy alignment with five-subsystem architecture
- Compliance with Six Immutable Standards
- Boundary integrity between Web Module and subsystems
- Phase 1 scope boundaries (no Phase 2 leakage)
- Development metrics exposure

**One critical constraint requires explicit architectural enforcement:** Drive rules are read-only from the Web Module. No autonomous modification of drive evaluation is permitted.

---

## 1. Philosophy Alignment Check

### 1.1 Five-Subsystem Architecture Integrity

**COMPLIANT**

The Web Module must function as a **read-only sensor and display layer**, not as a 6th subsystem:

| Subsystem | Role | Web Module Interaction |
|-----------|------|------------------------|
| Decision Making | Central cognitive loop | Web reads prediction state, action selections (no writes) |
| Communication | Input/output translation | Web reads conversation history (input flows through Communication layer, not Web directly) |
| Learning | Experience consolidation | Web reads learned entities, edges, consolidation events (no writes) |
| Drive Engine | Motivation computation | Web reads drive state via IDriveStateReader (read-only interface) |
| Planning | Opportunity research | Web reads opportunities, plans, simulations (no writes) |

**Critical constraint:** Chat input HTTP endpoint must flow:
```
HTTP POST /api/chat → Communication.parseInput() → Decision Making → response
NOT directly into decision making
```

This preserves contingency tracking in Communication and maintains the architectural flow.

---

### 1.2 World Knowledge Graph Read-Only Access

**COMPLIANT**

The WKG graph API (`GET /api/wkg/query`, WebSocket `/ws/graph`) must be **read-only**:

- Graph visualization queries: ALLOWED
- Confidence value retrieval: ALLOWED
- Provenance inspection: ALLOWED
- Node/edge writes: **PROHIBITED**
- Schema modification: **PROHIBITED**
- Automated entity extraction from UI: **PROHIBITED**

All writes to the WKG come exclusively through the **Knowledge module** (Learning subsystem), which enforces:
- Provenance tagging
- Confidence initialization
- Contradiction detection
- Type 1/Type 2 ratios

**Implementation note:** Graph API endpoint should be backed by Neo4j read-only user credential (no write permissions at database layer).

---

### 1.3 Communication Layer Routing

**COMPLIANT WITH ENFORCEMENT REQUIREMENT**

Text input must route through Communication, not bypass it:

**CORRECT FLOW:**
```
User types in dashboard → POST /api/chat/send
→ Communication.parseInput() [parses intent, context]
→ Communication.embedInput() [creates episodic memory in TimescaleDB]
→ Decision Making.selectAction() [Type 1/Type 2 arbitration]
→ response selected and executed
→ Communication.generateResponse() [LLM if Type 2]
→ WebSocket broadcast to all connected clients
```

**PROHIBITED FLOW:**
```
POST /api/decision/action ← Direct action selection (bypasses Communication)
POST /api/drive/override ← Direct drive modification (violates drive isolation)
POST /api/graph/upsert ← Direct WKG write (violates Knowledge module)
```

---

## 2. Six Immutable Standards Check

### 2.1 Standard 1: The Theater Prohibition

**COMPLIANT WITH DASHBOARD REQUIREMENT**

Dashboard must display **drive state alongside Sylphie's responses** to prevent the Theater illusion:

When rendering a response, the dashboard MUST show:
```typescript
{
  "response": "I'm curious about that!",
  "driveState": {
    "curiosity": 0.75,
    "socialConnection": 0.60,
    "anxiety": 0.25
  },
  "responseSource": "Type 1" // or "Type 2"
}
```

This design prevents the UI from becoming a "puppet show" where responses appear emotionally driven when the underlying drives don't support them.

**Verification:** In development metrics, the correlation between response emotional content and corresponding drive state must be tracked. If correlation < 0.50, it indicates Theater violation.

---

### 2.2 Standard 2: The Contingency Requirement

**COMPLIANT WITH TRACKING REQUIREMENT**

Chat input must be traceable to a specific behavior and outcome:

```typescript
{
  "inputId": "msg_12345",
  "timestamp": "2026-03-29T14:22:00Z",
  "content": "What do you think about that idea?",
  "predictions": [
    {
      "id": "pred_001",
      "action": "REQUEST_CLARIFICATION",
      "confidence": 0.72,
      "expectedOutcome": "Guardian provides more context"
    }
  ],
  "selectedAction": "REQUEST_CLARIFICATION",
  "outcome": {
    "actualResponse": "Guardian provided context",
    "rewardSignal": "Satisfaction +0.15"
  }
}
```

Every interaction flows through TimescaleDB with this structure. The Web Module can expose this contingency chain through:
- `/api/episodes/{inputId}/contingency` — retrieve the full input→behavior→outcome chain
- WebSocket feed: `/ws/contingency-stream` — real-time contingency events

---

### 2.3 Standard 3: The Confidence Ceiling

**COMPLIANT WITH READ-ONLY ENFORCEMENT**

Graph API must expose confidence values accurately and prevent circumvention:

```typescript
GET /api/wkg/node/{nodeId}
{
  "id": "node_mug_1",
  "label": "Coffee Mug",
  "confidence": 0.72,
  "provenance": "GUARDIAN",
  "baseConfidence": 0.60,
  "retrievalCount": 3,
  "lastRetrieved": "2026-03-29T14:00:00Z"
}
```

**Critical constraint:** The API must REJECT any attempt to directly modify confidence:
```
POST /api/wkg/node/{nodeId}/confidence ← 400 Bad Request
"Confidence is computed by the system. Use Guardian feedback."
```

Confidence ceiling (0.60 for untested knowledge) is enforced at the Knowledge module level, not the Web layer. The Web Module merely reports the computed values.

---

### 2.4 Standard 4: The Shrug Imperative

**COMPLIANT WITH API SUPPORT**

When Sylphie's decision-making system cannot exceed the action threshold, the API must be able to represent incomprehension:

```typescript
{
  "response": "*shrugs*",
  "actionType": "SIGNAL_INCOMPREHENSION",
  "reason": "No Type 1 reflex above threshold; Type 2 declined due to high uncertainty",
  "highestPredictionConfidence": 0.38,
  "actionThreshold": 0.50
}
```

The dashboard MUST NOT hide this state. Rendering Sylphie as confidently answering random low-confidence questions would violate the Shrug Imperative.

**Dashboard behavior:** When incomprehension is signaled, display it visually (e.g., "Sylphie is uncertain") rather than as a confident response.

---

### 2.5 Standard 5: The Guardian Asymmetry

**COMPLIANT WITH FEEDBACK WEIGHTING**

Guardian input (chat, direct feedback) must be distinguishable and weighted appropriately:

```typescript
POST /api/chat/feedback
{
  "targetInputId": "msg_12345",
  "feedbackType": "CORRECTION", // or "CONFIRMATION"
  "content": "Actually, that's not quite right.",
  "guardianiD": "guardian_jim"
}
```

The Drive Engine processes this with 3x weight (for correction) or 2x (for confirmation). The Web Module role:
1. Deliver feedback to Communication layer (tagged as guardian input)
2. Expose feedback history: `GET /api/learning/guardian-feedback`
3. Track guardian response latency: measure if feedback is <30s (Social bonus)

Dashboard can visualize feedback weight:
```typescript
{
  "feedback": "Actually, that's not quite right.",
  "weight": 3.0, // Correction weight
  "impactedDrives": ["Moral Valence", "Integrity"],
  "driveShifts": [
    { "drive": "Moral Valence", "shift": -0.15 }
  ]
}
```

---

### 2.6 Standard 6: No Self-Modification of Evaluation

**COMPLIANT WITH READ-ONLY ENFORCEMENT**

Drive rules must be read-only from the Web Module. The dashboard is a window into drive state, not a control panel:

**ALLOWED:**
```
GET /api/drive-rules ← View current rules
GET /api/drive-rules/{ruleId} ← Inspect a specific rule
```

**PROHIBITED:**
```
POST /api/drive-rules ← Create rule (BLOCKED)
PUT /api/drive-rules/{ruleId} ← Modify rule (BLOCKED)
DELETE /api/drive-rules/{ruleId} ← Delete rule (BLOCKED)
POST /api/drive/{driveId}/override ← Override drive value (BLOCKED) ← Version 1 pattern, must not exist
```

If Sylphie needs to propose a new rule, it flows through the Drive Engine:
```
Drive Engine → proposes rule → stores in Postgres with status: PROPOSED
→ Guardian reviews via dashboard
→ Guardian approves (PUT /api/drive-rules/{id}/approve by guardian, not autonomous)
→ Rule activates
```

---

## 3. Architecture Compliance Check

### 3.1 Module Boundaries

**COMPLIANT**

The Web Module must respect these import boundaries:

```typescript
// ✅ ALLOWED
import { IDriveStateReader } from '@sylphie/drive-engine';
import { WKGInterface } from '@sylphie/knowledge';
import { ConversationService } from '@sylphie/communication';
import { EpisodeService } from '@sylphie/decision-making';
import { TimescaleEvents } from '@sylphie/events';

// ❌ PROHIBITED
import { DriveEvaluator } from '@sylphie/drive-engine'; // Only read, never write
import { LearningConsolidation } from '@sylphie/learning'; // Learning owns writes
```

The Web Module acts as a **translator**, not a **coordinator**. It converts domain model objects into HTTP/WebSocket messages without business logic.

---

### 3.2 Drive State Access Pattern

**COMPLIANT**

All drive state reads must flow through a read-only interface:

```typescript
// Drive Engine interface (isolated process)
interface IDriveStateReader {
  getDriveState(driveId: string): Promise<{
    value: number; // 0.0 to 1.0
    lastUpdated: Date;
    accumulationRate: number;
    decayRate: number;
  }>;
  getAllDrives(): Promise<Drive[]>;
  getHistoricalTrend(driveId: string, hours: number): Promise<number[]>;
}

// Web Module usage
@Get('/api/drives/:id')
async getDrive(@Param('id') driveId: string) {
  const drive = await this.driveStateReader.getDriveState(driveId);
  return {
    id: driveId,
    value: drive.value,
    trend: await this.driveStateReader.getHistoricalTrend(driveId, 24)
  };
}
```

The drive state is computed in a separate process. The Web Module reads a socket, semaphore, or database replica. It has zero write access to the evaluation function.

---

### 3.3 Chat Input Flow

**COMPLIANT WITH ROUTING REQUIREMENT**

Chat input endpoint must delegate to Communication:

```typescript
@Post('/api/chat')
async sendMessage(@Body() payload: { text: string }) {
  // Step 1: Communication parses and embeds
  const parsed = await this.communication.parseInput(payload.text, {
    context: await this.wkg.getContextFor('guardian_jim'),
    recentEpisodes: await this.episodes.getLast(5)
  });

  // Step 2: Communication stores in TimescaleDB
  await this.events.emitInputEvent({
    type: 'GUARDIAN_INPUT',
    content: payload.text,
    parsedIntent: parsed.intent,
    timestamp: new Date()
  });

  // Step 3: Decision Making selects action (happens asynchronously)
  // Web Module waits for response via event subscription

  // Step 4: Response generated and delivered via WebSocket
  return {
    status: 'received',
    will_respond_in: '100-500ms'
  };
}

// WebSocket waits for response
@WebSocketGateway()
class ChatGateway {
  @SubscribeMessage('chat:response')
  onChatResponse(@MessageBody() payload: ChatResponse) {
    // Broadcast to all connected clients
    this.server.emit('chat:response', payload);
  }
}
```

---

### 3.4 Knowledge Graph Write Protection

**COMPLIANT**

Neo4j must be accessed with read-only credentials at the database layer:

```sql
-- Neo4j RBAC (if available in Community Edition, use application-level enforcement)
GRANT MATCH, READ ON DATABASE sylphie TO web_read_user;
DENY WRITE ON DATABASE sylphie TO web_read_user;
```

Application-level enforcement:

```typescript
interface WKGReadInterface {
  query(cypher: string): Promise<any[]>;
  // Note: No write/upsert/delete methods exposed
}

// Usage
const results = await this.wkg.query(
  `MATCH (n:Entity {type: $type}) RETURN n`,
  { type: 'Person' }
);
```

---

## 4. Phase Boundary Check

### 4.1 Phase 1 Scope (Cognitive Architecture)

**COMPLIANT — NO PHASE 2 LEAKAGE**

Epic 9 deals with **software interfaces to cognitive state**, not **physical exploration**:

**IN SCOPE:**
- HTTP endpoints for graph queries
- WebSocket telemetry (drive state, predictions, learning events)
- Conversation history and input/output
- Development metrics (Type 1/Type 2 ratio, prediction MAE, provenance statistics)
- Health checks (database connectivity, subsystem status)

**OUT OF SCOPE (Phase 2):**
- Camera endpoints (`/api/vision/object-detection`)
- Motor control endpoints (`/api/motors/move-to`)
- Sensor fusion endpoints (`/api/sensors/fusion-state`)
- Physical exploration metrics
- Embodied prediction validation

**Verification:** Scan the Epic 9 endpoint specifications for any routes containing `camera`, `motor`, `sensor`, `vision`, `movement`, `physical`. If any exist, they must be moved to Epic N (Phase 2 infrastructure planning).

---

### 4.2 Drive Isolation (Not Phase 2 Hardware Isolation)

**COMPLIANT**

Epic 9 does not require or implement hardware-level drive isolation. It assumes the Drive Engine runs in a separate process (protected at the OS/container level), and Epic 9 merely reads the output:

```typescript
// All Web access is read-only
const driveState = await this.driveStateReader.getDriveState('curiosity');
// No write access exists
```

If the Drive Engine in Phase 2 moves to dedicated hardware (ESP32 or similar), the Web Module interface remains unchanged.

---

## 5. Development Metrics API Compliance

### 5.1 Primary Health Metrics Exposure

**COMPLIANT**

Epic 9 must expose all seven Primary Health Metrics defined in CANON:

| Metric | Endpoint | Calculation |
|--------|----------|-------------|
| Type 1 / Type 2 ratio | `GET /api/metrics/type-ratio` | count(Type 1 actions) / count(all actions) |
| Prediction MAE | `GET /api/metrics/prediction-mae` | mean((predicted - actual)^2)^0.5 |
| Experiential provenance ratio | `GET /api/metrics/provenance-ratio` | count(SENSOR + GUARDIAN + INFERENCE edges) / count(all edges) |
| Behavioral diversity index | `GET /api/metrics/diversity-index` | unique action types in last 20 actions |
| Guardian response rate | `GET /api/metrics/guardian-response-rate` | comment responses within 30s / total comments |
| Interoceptive accuracy | `GET /api/metrics/interoception-accuracy` | correlation(predicted drive state, actual drive state) |
| Mean drive resolution time | `GET /api/metrics/drive-resolution-time` | avg(time to return drive below threshold) |

**Implementation:**
```typescript
@Get('/api/metrics/type-ratio')
async getTypeRatio() {
  const actions = await this.events.queryActions({ since: '30 days ago' });
  const type1 = actions.filter(a => a.type === 'Type1').length;
  const all = actions.length;
  return {
    ratio: type1 / all,
    type1Count: type1,
    totalCount: all,
    trend: [0.12, 0.15, 0.18, 0.22, 0.25] // Historical trend
  };
}
```

All metrics must be queryable with time windows: `/api/metrics/{metric}?since=7d&until=today`

---

### 5.2 Lesion Test Support

**COMPLIANT**

The dashboard must support manual lesion testing (removing LLM access):

```typescript
@Post('/api/admin/lesion-test/start')
async startLesionTest(@Body() { duration: number }) {
  // Guardian can toggle LLM access for a time window
  await this.configService.set('llm_enabled', false);
  return {
    status: 'lesion test started',
    duration_ms: duration,
    will_restore_at: new Date(Date.now() + duration)
  };
}

@Get('/api/metrics/lesion-test-performance')
async getLesionTestMetrics() {
  // Compare Type 1 success rate during lesion vs. normal
  return {
    type1_success_rate: 0.72,
    type1_latency_ms: 145,
    failures_requiring_llm: 28,
    autonomous_capability_estimate: '72% of situations handled'
  };
}
```

---

## 6. Risks and Concerns

### 6.1 **HIGH RISK:** Dashboard as Control Panel

**MITIGATION REQUIRED**

The primary risk is dashboard evolution into a "control panel" that bypasses the cognitive loop:

**Bad Pattern:**
```
Guardian adjusts drive value via dashboard
→ System optimizes behavior to match new target
→ Drive Engine loses autonomy
→ Violates Standard 6 (No Self-Modification of Evaluation)
```

**Mitigation:**
- Dashboard is **read-only for drive values** (except rule proposals)
- Any drive modification flows through the normal guardian feedback channel (text input)
- No direct `/api/drive/{id}/set` endpoints
- All state changes are **event-based**, not imperative commands

**Dashboard capability:**
- View drive state (read-only)
- Propose new drive rules (queued for review, not auto-active)
- Provide feedback on Sylphie's responses (goes through Communication, weighted 2-3x)
- Nothing more

---

### 6.2 **MEDIUM RISK:** Hallucinated Knowledge Amplification

**MITIGATION REQUIRED**

If the dashboard exposes WKG nodes with low confidence (LLM_GENERATED, base 0.35), the guardian might accidentally reinforce hallucinated knowledge:

**Bad scenario:**
```
Guardian views graph
→ Sees node: "Jim loves coffee" (confidence 0.38, LLM_GENERATED)
→ Thinks "that's right, I should acknowledge this"
→ Provides guardian feedback → confidence jumps to 0.60
→ Hallucination locks in
```

**Mitigation:**
- Graph API must flag provenance visually: "⚠️ LLM-generated, low confidence"
- Nodes with confidence < 0.50 should be visually de-emphasized
- Guardian feedback form should prompt: "Is this actually true?" before accepting
- Lesion test should regularly expose hallucinations (what can Sylphie do without LLM?)

---

### 6.3 **MEDIUM RISK:** Drive Override Endpoints (V1 Pattern)

**REQUIREMENT: MUST NOT EXIST**

Version 1 had endpoints like:
```
POST /api/drive/curiosity/add?value=0.2
```

This cannot exist in v2. The dashboard must never directly modify drive state.

**Verification:** Scan all endpoint definitions. If any of these patterns exist, they are BLOCKING issues:
```
POST /api/drive/{id}/* ← Any modification endpoint
PUT /api/drive/{id}/* ← Any update endpoint
DELETE /api/drive/* ← Delete operations
POST /api/action-override ← Force an action
```

These must all be removed.

---

### 6.4 **LOW RISK:** Graph Visualization Performance

The WKG can grow large (thousands of nodes). Graph query performance must degrade gracefully:

```typescript
@Get('/api/wkg/query')
async queryGraph(@Query('q') cypher: string, @Query('limit') limit: number = 100) {
  const timeout = 5000; // 5 second timeout
  const results = await this.wkg.queryWithTimeout(cypher, timeout);
  if (results.truncated) {
    return {
      ...results,
      warning: 'Results truncated; use more specific query'
    };
  }
  return results;
}
```

---

### 6.5 **LOW RISK:** WebSocket Connection Management

Real-time drive state and action streams can create connection overhead:

```typescript
// Throttle telemetry at source
const TELEMETRY_THROTTLE_MS = 100; // Emit at most every 100ms
const DRIVE_UPDATE_THROTTLE_MS = 500; // Drives update at most every 500ms
```

---

## 7. CANON Alignment Summary

| CANON Principle | Epic 9 Implementation | Compliance |
|-----------------|----------------------|------------|
| LLM is voice, not mind | Web reads from WKG, not LLM | ✅ COMPLIANT |
| Five subsystems architecture | Web Module is transport layer, not 6th subsystem | ✅ COMPLIANT |
| WKG is the brain | Web reads WKG (read-only) | ✅ COMPLIANT |
| Drive isolation | Web reads IDriveStateReader (read-only interface) | ✅ COMPLIANT |
| Provenance is sacred | Graph API exposes and respects provenance tags | ✅ COMPLIANT |
| Dual-process cognition | Web visualizes Type 1/Type 2 ratio and arbitration | ✅ COMPLIANT |
| Guardian Asymmetry | Feedback weighted 2-3x at Communication layer | ✅ COMPLIANT |
| Theater Prohibition | Dashboard shows drive state + response together | ✅ COMPLIANT |
| Contingency Requirement | Web exposes input→behavior→outcome chains | ✅ COMPLIANT |
| Confidence Ceiling | Graph API respects 0.60 threshold, read-only | ✅ COMPLIANT |
| Shrug Imperative | Web can represent incomprehension state | ✅ COMPLIANT |
| No Self-Modification | Drive rules read-only; proposals go to guardian | ✅ COMPLIANT |

---

## 8. Verdict

**STATUS: COMPLIANT WITH CRITICAL CONSTRAINTS**

Epic 9 is architecturally sound and CANON-aligned, **provided these constraints are enforced in implementation**:

### Must-Enforce Constraints

1. **Chat input routes through Communication layer** — not bypassing it
2. **WKG is read-only** — no Web-initiated writes
3. **Drive state is read-only** — no direct drive value modification
4. **Drive rules are read-only** — proposals only, approval by guardian
5. **No drive override endpoints** — remove any `/api/drive/{id}/set` or similar
6. **Provenance is displayed** — low-confidence nodes flagged as LLM-generated
7. **Theater Prohibition is enforced** — response + drive state shown together
8. **Development metrics are exposed** — all seven primary metrics queryable

### Recommended Early Implementations

1. **Lesion test support** — ability to disable LLM for testing
2. **Metrics dashboard** — Type 1/Type 2 ratio graphed over time
3. **Guardian feedback form** — with provenance awareness
4. **Drive history visualization** — 24-hour rolling trend graphs
5. **Contingency explorer** — input → behavior → outcome chains

### No Blocking Issues

This epic can proceed to planning and implementation without modification to the CANON. Architects should use this review to validate design decisions and implementation patterns.

---

## Appendix: Endpoint Checklist

Use this checklist during Epic 9 implementation to ensure CANON compliance:

```
[ ] Health check endpoint exists (databases + subsystems)
[ ] Drive state read-only endpoint implemented
[ ] Drive state WebSocket real-time feed implemented
[ ] WKG query endpoint (read-only)
[ ] WKG query WebSocket feed (read-only)
[ ] Conversation history endpoint
[ ] Chat input endpoint (routes through Communication)
[ ] Guardian feedback endpoint
[ ] All seven primary metrics exposed
[ ] Type 1/Type 2 ratio queryable
[ ] Prediction MAE queryable
[ ] Provenance ratio queryable
[ ] Behavioral diversity queryable
[ ] Guardian response rate queryable
[ ] Interoceptive accuracy queryable
[ ] Drive resolution time queryable
[ ] Lesion test control endpoint
[ ] Graph visualization uses read-only access
[ ] No `/api/drive/*/override` endpoints exist
[ ] No `/api/graph/upsert` or write endpoints exist
[ ] Drive rules endpoint read-only
[ ] Response includes drive state alongside content
[ ] Graph nodes display provenance and confidence
[ ] Low-confidence nodes visually de-emphasized
[ ] WebSocket connections throttle telemetry
[ ] All endpoints require authentication
[ ] Type checking passes: `npx tsc --noEmit`
```

---

**Canon, Project Integrity Guardian**
**Sylphie Labs**
**2026-03-29**

---

**Next Steps for Epic 9 Team:**

1. Review this compliance assessment with project leadership
2. Use the constraints section to create the Epic 9 detailed design document
3. Plan implementations against the endpoint checklist
4. Submit architecture diagrams showing Web Module boundaries for follow-up review
5. Plan testing strategy including lesion test validation
