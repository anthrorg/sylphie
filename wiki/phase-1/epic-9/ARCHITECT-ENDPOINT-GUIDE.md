# Epic 9: Detailed Endpoint Specification Guide
## For Architecture & Design Phase

**Audience:** Epic 9 architects, API designers
**Purpose:** Validate endpoint design against CANON constraints
**Status:** Design pattern reference

---

## API Organization

All endpoints are scoped under `/api/` with WebSocket events under `/ws/`. All endpoints require authentication (guardian bearer token).

---

## 1. Health & Connectivity

### GET /api/health

**Purpose:** Verify all subsystems and databases are operational

**Response:**
```json
{
  "status": "healthy",
  "subsystems": {
    "decision_making": { "status": "running", "latency_ms": 45 },
    "communication": { "status": "running", "latency_ms": 32 },
    "learning": { "status": "running", "latency_ms": 78 },
    "drive_engine": { "status": "running", "latency_ms": 25 },
    "planning": { "status": "running", "latency_ms": 156 }
  },
  "databases": {
    "wkg_neo4j": { "status": "connected", "node_count": 1247, "edge_count": 3891 },
    "timescaledb": { "status": "connected", "event_count": 45678 },
    "postgres_drive_rules": { "status": "connected", "rule_count": 23 }
  },
  "timestamp": "2026-03-29T14:22:00Z"
}
```

**CANON Alignment:**
- No business logic; pure status reporting
- Allows guardian to verify all five subsystems are operational

---

## 2. Drive State API

### GET /api/drives

**Purpose:** Current state of all 12 drives

**Response:**
```json
{
  "timestamp": "2026-03-29T14:22:00Z",
  "drives": [
    {
      "id": "system_health",
      "name": "System Health",
      "category": "core",
      "value": 0.55,
      "accumulation_rate": 0.02,
      "decay_rate": 0.001,
      "description": "Takes care of herself without being dramatic"
    },
    {
      "id": "curiosity",
      "name": "Curiosity",
      "category": "complement",
      "value": 0.78,
      "accumulation_rate": 0.03,
      "decay_rate": 0.0015,
      "description": "Actively seeks out what she doesn't understand"
    }
    // ... 10 more drives
  ]
}
```

**CANON Alignment:** Standard 1 (Theater)
- Drive state is shown alongside responses for transparency
- Values are read-only; no direct modification endpoint

---

### GET /api/drives/:id

**Purpose:** Detailed view of a single drive

**Response:**
```json
{
  "id": "curiosity",
  "name": "Curiosity",
  "category": "complement",
  "current_value": 0.78,
  "accumulation_rate": 0.03,
  "decay_rate": 0.0015,
  "last_updated": "2026-03-29T14:21:45Z",
  "recent_history": {
    "24h": [0.65, 0.67, 0.70, 0.72, 0.74, 0.76, 0.78],
    "7d_average": 0.71,
    "30d_average": 0.65
  },
  "contingency_history": [
    {
      "timestamp": "2026-03-29T14:10:00Z",
      "event": "Asked question about world model",
      "relief_amount": -0.08,
      "new_value": 0.76
    },
    {
      "timestamp": "2026-03-29T13:45:00Z",
      "event": "Learned new concept about spatial relationships",
      "relief_amount": -0.15,
      "new_value": 0.71
    }
  ]
}
```

**CANON Alignment:** Standard 2 (Contingency)
- Shows what events caused drive changes
- Guardian can trace behavior to drive relief

---

### WebSocket /ws/drives

**Purpose:** Real-time drive state updates

**Subscribe:**
```javascript
ws.send(JSON.stringify({
  type: 'SUBSCRIBE',
  channel: 'drives'
}));
```

**Broadcast (server → client every 500ms):**
```json
{
  "type": "drive_update",
  "timestamp": "2026-03-29T14:22:00Z",
  "changes": [
    {
      "drive_id": "curiosity",
      "old_value": 0.78,
      "new_value": 0.79,
      "reason": "Processing novel information"
    }
  ],
  "all_drives": [
    { "id": "system_health", "value": 0.55 },
    { "id": "moral_valence", "value": 0.62 }
    // ... all 12
  ]
}
```

**CANON Alignment:** Standard 1 (Theater)
- Real-time transparency into drive dynamics
- Guardian sees how Sylphie's motivation state evolves

---

### GET /api/drive-rules

**Purpose:** View all current drive rules (read-only)

**Response:**
```json
{
  "rules": [
    {
      "id": "rule_001",
      "name": "Curiosity Relief on Question",
      "condition": "event.type == 'PARSE_INPUT' AND event.intent == 'QUESTION'",
      "effect": "curiosity -= 0.08",
      "confidence": 0.85,
      "provenance": "GUARDIAN",
      "created_at": "2026-03-15T10:00:00Z",
      "last_used": "2026-03-29T14:15:00Z",
      "use_count": 127
    }
  ]
}
```

**CANON Alignment:** Standard 6 (No Self-Modification)
- Rules are READ-ONLY from Web Module
- All modifications must go through Guardian approval

---

### POST /api/drive-rules-proposal *(Guardian proposal, not direct creation)*

**Purpose:** Propose a new drive rule (queued for guardian review, not auto-active)

**Request:**
```json
{
  "name": "Anxiety Relief on Successful Action",
  "condition": "event.type == 'ACTION' AND event.outcome == 'SUCCESS' AND drive.anxiety > 0.5",
  "effect": "anxiety -= 0.12",
  "explanation": "Successful action under uncertainty should reduce anxiety"
}
```

**Response:**
```json
{
  "status": "queued",
  "proposal_id": "prop_xxx",
  "message": "Rule proposal queued for guardian review",
  "approval_endpoint": "/api/admin/approve-rule-proposal/prop_xxx"
}
```

**CANON Alignment:** Standard 6 (No Self-Modification)
- System can PROPOSE rules via Drive Engine
- Guardian must explicitly APPROVE
- Only then do rules become active

---

## 3. World Knowledge Graph API

### GET /api/wkg/query

**Purpose:** Execute read-only Cypher query against WKG

**Request:**
```
GET /api/wkg/query?q=MATCH%20(n:Entity)%20WHERE%20n.type%20%3D%20%27Person%27%20RETURN%20n&limit=100
```

**Response:**
```json
{
  "results": [
    {
      "id": "node_jim_001",
      "label": "Jim",
      "type": "Person",
      "properties": {
        "expertise": "Software Architecture",
        "communication_style": "Precise and Technical"
      },
      "confidence": 0.87,
      "provenance": "GUARDIAN",
      "created_at": "2026-03-15T08:00:00Z"
    }
  ],
  "count": 47,
  "truncated": false
}
```

**CANON Alignment:** Standard 3 (Confidence Ceiling)
- Read-only access
- Confidence values exposed accurately
- Provenance displayed

---

### GET /api/wkg/node/:id

**Purpose:** Detailed view of a single node

**Response:**
```json
{
  "id": "node_mug_coffee_001",
  "label": "Coffee Mug",
  "type": "PhysicalObject",
  "confidence": 0.72,
  "base_confidence": 0.40,
  "provenance": "SENSOR",
  "created_at": "2026-03-20T12:00:00Z",
  "last_retrieved": "2026-03-29T13:45:00Z",
  "retrieval_count": 5,
  "properties": {
    "color": "blue",
    "material": "ceramic",
    "location": "desk"
  },
  "edges": {
    "outbound": [
      {
        "type": "CAN_CONTAIN",
        "target_node": "node_coffee_001",
        "confidence": 0.68,
        "provenance": "INFERENCE"
      }
    ],
    "inbound": [
      {
        "type": "IS_HOLDING",
        "source_node": "node_jim_001",
        "confidence": 0.45,
        "provenance": "LLM_GENERATED",
        "warning": "Low confidence LLM-generated; not confirmed by guardian"
      }
    ]
  }
}
```

**CANON Alignment:**
- Standard 3 (Confidence Ceiling): ceiling enforcement visible
- Standard 7 (Provenance): every edge tagged with source
- Low-confidence LLM nodes flagged for guardian awareness

---

### GET /api/wkg/node/:id/edges

**Purpose:** View all edges connected to a node (for large-degree nodes)

**Response:**
```json
{
  "node_id": "node_jim_001",
  "outbound_edges": [ /* list of edges */ ],
  "inbound_edges": [ /* list of edges */ ],
  "summary": {
    "total_edges": 247,
    "average_confidence": 0.71,
    "provenance_breakdown": {
      "SENSOR": 45,
      "GUARDIAN": 89,
      "LLM_GENERATED": 67,
      "INFERENCE": 46
    }
  }
}
```

---

### WebSocket /ws/wkg

**Purpose:** Subscribe to graph updates (new nodes/edges)

**Subscribe:**
```javascript
ws.send(JSON.stringify({
  type: 'SUBSCRIBE',
  channel: 'graph',
  filters: {
    node_types: ['Person', 'Location'], // Optional
    min_confidence: 0.50
  }
}));
```

**Broadcast (on graph update):**
```json
{
  "type": "graph_update",
  "timestamp": "2026-03-29T14:22:00Z",
  "node_added": {
    "id": "node_xxx",
    "label": "New Entity",
    "type": "Location",
    "confidence": 0.42,
    "provenance": "LLM_GENERATED"
  },
  "edge_added": {
    "source": "node_jim_001",
    "type": "VISITED",
    "target": "node_xxx",
    "confidence": 0.35
  }
}
```

**CANON Alignment:** Standard 7 (Provenance)
- All graph changes include provenance
- Guardian can monitor knowledge growth in real-time

---

## 4. Conversation & Chat API

### GET /api/chat/history

**Purpose:** Retrieve conversation history

**Request:**
```
GET /api/chat/history?limit=50&since=2026-03-29T00:00:00Z
```

**Response:**
```json
{
  "messages": [
    {
      "id": "msg_12345",
      "timestamp": "2026-03-29T14:15:00Z",
      "speaker": "guardian",
      "content": "What do you think about learning from feedback?",
      "input_type": "QUESTION",
      "processing": {
        "parsed_intent": "REQUEST_REFLECTION",
        "confidence": 0.87,
        "latency_ms": 145
      }
    },
    {
      "id": "msg_12346",
      "timestamp": "2026-03-29T14:15:30Z",
      "speaker": "sylphie",
      "content": "I think feedback helps me understand the world better.",
      "response_source": "Type1",
      "drive_state_at_response": {
        "curiosity": 0.72,
        "moral_valence": 0.61,
        "integrity": 0.68
      }
    }
  ],
  "count": 50
}
```

**CANON Alignment:**
- Standard 1 (Theater): drive state shown with responses
- Standard 2 (Contingency): input → response chain preserved
- Standard 5 (Guardian Asymmetry): guardian input marked explicitly

---

### POST /api/chat/send

**Purpose:** Send a message (routes through Communication subsystem)

**Request:**
```json
{
  "text": "Tell me about what you learned today."
}
```

**Immediate Response:**
```json
{
  "status": "received",
  "message_id": "msg_12347",
  "will_respond_in_ms": "100-500",
  "estimated_type": "Type1 or Type2"
}
```

**Response delivered via WebSocket /ws/chat:**
```json
{
  "type": "chat_response",
  "message_id": "msg_12347",
  "response_id": "msg_12348",
  "content": "Today I learned that...",
  "response_source": "Type1",
  "confidence": 0.76,
  "latency_ms": 234,
  "drive_state": {
    "curiosity": 0.71,
    "moral_valence": 0.60,
    "integrity": 0.69
  }
}
```

**CANON Alignment:**
- Standard 2 (Contingency): message_id links input to response
- Standard 5 (Guardian Asymmetry): guardian input is marked and weighted 2-3x by Communication
- Flows through Communication layer, not direct to Decision Making

---

### POST /api/chat/feedback

**Purpose:** Guardian provides explicit feedback on a Sylphie response

**Request:**
```json
{
  "target_message_id": "msg_12348",
  "feedback_type": "CORRECTION",
  "content": "Actually, that's not quite right. The correct fact is..."
}
```

**Response:**
```json
{
  "status": "accepted",
  "feedback_id": "fb_xxx",
  "weight": 3.0,
  "message": "Correction received and weighted 3x by Drive Engine",
  "affected_drives": ["Moral Valence", "Integrity"]
}
```

**CANON Alignment:** Standard 5 (Guardian Asymmetry)
- Corrections weighted 3x
- Confirmations weighted 2x
- Drives listed so guardian can see impact

---

### WebSocket /ws/chat

**Purpose:** Real-time conversation feed

**Messages:**
- `chat_input` — guardian sends message
- `chat_response` — Sylphie responds
- `typing_indicator` — Sylphie is thinking
- `prediction_update` — Sylphie's prediction about what will happen

---

## 5. Development Metrics API

### GET /api/metrics/type-ratio

**Purpose:** Type 1 / Type 2 decision ratio over time

**Request:**
```
GET /api/metrics/type-ratio?since=7d&aggregate=daily
```

**Response:**
```json
{
  "metric": "type1_type2_ratio",
  "period": "7d",
  "current_ratio": 0.35,
  "trend": [
    { "timestamp": "2026-03-23", "ratio": 0.22, "type1_count": 15, "type2_count": 54 },
    { "timestamp": "2026-03-24", "ratio": 0.25, "type1_count": 18, "type2_count": 54 },
    { "timestamp": "2026-03-29", "ratio": 0.35, "type1_count": 28, "type2_count": 52 }
  ],
  "summary": {
    "direction": "increasing",
    "improvement_rate": "0.013 per day",
    "estimated_maturity_date": "2026-05-15"
  }
}
```

**CANON Alignment:**
- Primary Health Metric #1
- Shows Sylphie's autonomy development
- Guardian can see whether development is happening

---

### GET /api/metrics/prediction-mae

**Purpose:** Mean Absolute Error of predictions across all subsystems

**Response:**
```json
{
  "metric": "prediction_mae",
  "period": "7d",
  "current_mae": 0.18,
  "subsystem_breakdown": {
    "decision_making": {
      "mae": 0.15,
      "sample_count": 342,
      "trend": "improving"
    },
    "communication": {
      "mae": 0.22,
      "sample_count": 127,
      "trend": "stable"
    },
    "planning": {
      "mae": 0.25,
      "sample_count": 43,
      "trend": "improving"
    }
  }
}
```

**CANON Alignment:** Primary Health Metric #2

---

### GET /api/metrics/provenance-ratio

**Purpose:** Graph provenance breakdown (self-constructed vs. LLM-provided knowledge)

**Response:**
```json
{
  "metric": "provenance_ratio",
  "period": "7d",
  "edge_breakdown": {
    "SENSOR": { "count": 234, "percentage": 25.8 },
    "GUARDIAN": { "count": 189, "percentage": 20.9 },
    "INFERENCE": { "count": 156, "percentage": 17.2 },
    "LLM_GENERATED": { "count": 431, "percentage": 47.6 }
  },
  "experiential_ratio": 0.639,
  "trend": "increasing",
  "interpretation": "Graph is 64% self-constructed, 48% LLM-provided (overlaps exist)"
}
```

**CANON Alignment:** Primary Health Metric #3
- Shows whether Sylphie is learning or just being populated by LLM
- Healthy trend: increasing experiential ratio

---

### GET /api/metrics/diversity-index

**Purpose:** Behavioral diversity (action type variety)

**Response:**
```json
{
  "metric": "behavioral_diversity",
  "period": "20_action_window",
  "unique_action_types": 6,
  "action_breakdown": [
    { "type": "QUESTION", "count": 5 },
    { "type": "OBSERVATION", "count": 4 },
    { "type": "HYPOTHESIS", "count": 3 },
    { "type": "REQUEST_CLARIFICATION", "count": 4 },
    { "type": "ACKNOWLEDGE", "count": 2 },
    { "type": "STATE_UNCERTAINTY", "count": 2 }
  ],
  "status": "healthy",
  "min_threshold": 4,
  "max_threshold": 8
}
```

**CANON Alignment:** Primary Health Metric #4
- Healthy range: 4-8 unique action types per 20 actions
- Prevents repetitive behavior patterns

---

### GET /api/metrics/guardian-response-rate

**Purpose:** How often guardian responds to Sylphie-initiated comments

**Response:**
```json
{
  "metric": "guardian_response_rate",
  "period": "7d",
  "sylphie_initiated_comments": 23,
  "responded_within_30s": 18,
  "response_rate": 0.78,
  "trend": "increasing",
  "response_time_distribution": {
    "0-10s": 8,
    "10-30s": 10,
    ">30s": 5
  }
}
```

**CANON Alignment:** Primary Health Metric #5
- Shows quality of Sylphie's self-initiated communication
- Social drive relief proportional to fast responses

---

### GET /api/metrics/interoception-accuracy

**Purpose:** Self-awareness fidelity (correlation between predicted and actual drive state)

**Response:**
```json
{
  "metric": "interoception_accuracy",
  "period": "7d",
  "correlation": 0.58,
  "healthy_threshold": 0.60,
  "status": "developing",
  "drive_accuracy_breakdown": [
    { "drive": "curiosity", "accuracy": 0.72 },
    { "drive": "anxiety", "accuracy": 0.45 },
    { "drive": "moral_valence", "accuracy": 0.61 },
    { "drive": "system_health", "accuracy": 0.38 }
  ]
}
```

**CANON Alignment:** Primary Health Metric #6
- Shows whether Sylphie understands her own internal state
- Healthy: > 0.60 correlation

---

### GET /api/metrics/drive-resolution-time

**Purpose:** Average time to resolve (return to baseline) each drive

**Response:**
```json
{
  "metric": "mean_drive_resolution_time",
  "period": "7d",
  "all_drives_average_ms": 4250,
  "per_drive": [
    { "drive": "curiosity", "avg_ms": 2340, "trend": "decreasing" },
    { "drive": "anxiety", "avg_ms": 5120, "trend": "increasing" },
    { "drive": "satisfaction", "avg_ms": 3890, "trend": "stable" }
  ],
  "interpretation": "Sylphie is learning to satisfy curiosity faster"
}
```

**CANON Alignment:** Primary Health Metric #7
- Shows efficiency of need satisfaction
- Healthy trend: decreasing (faster resolution)

---

### GET /api/metrics/all

**Purpose:** All seven metrics in one request

**Response:**
```json
{
  "period": "7d",
  "generated_at": "2026-03-29T14:22:00Z",
  "metrics": {
    "type_ratio": { ... },
    "prediction_mae": { ... },
    "provenance_ratio": { ... },
    "diversity_index": { ... },
    "guardian_response_rate": { ... },
    "interoception_accuracy": { ... },
    "drive_resolution_time": { ... }
  },
  "summary": {
    "overall_development": "on_track",
    "high_risk_indicators": [],
    "recommendations": []
  }
}
```

---

## 6. Lesion Test API (Admin)

### POST /api/admin/lesion-test/start

**Purpose:** Disable LLM for testing (guardian-only)

**Request:**
```json
{
  "duration_ms": 300000,
  "explanation": "Testing Type 1 capability alone"
}
```

**Response:**
```json
{
  "status": "started",
  "llm_enabled": false,
  "will_restore_at": "2026-03-29T14:27:00Z",
  "warning": "Sylphie will fail on novel situations without LLM"
}
```

---

### GET /api/metrics/lesion-test-performance

**Purpose:** Performance metrics during lesion test

**Response:**
```json
{
  "lesion_test_active": true,
  "duration_ms": 127000,
  "type1_success_rate": 0.72,
  "type1_failures": 8,
  "failures_requiring_llm": 8,
  "autonomous_capability_estimate": "72% of situations handled without LLM",
  "recommendations": [
    "Type 1 handles routine conversations well",
    "Fails on novel questions (expected)",
    "Would benefit from more Type 1 training on these scenarios"
  ]
}
```

**CANON Alignment:** The Lesion Test (CANON section 8.3)
- Ground truth for development
- Shows what Sylphie actually knows without LLM scaffolding

---

## 7. Contingency Explorer API

### GET /api/episodes/:inputId/contingency

**Purpose:** Trace a single input through behavior to outcome

**Response:**
```json
{
  "episode_id": "msg_12345",
  "input": {
    "timestamp": "2026-03-29T14:15:00Z",
    "content": "What do you think about learning?",
    "parsed_intent": "REQUEST_REFLECTION",
    "parsing_confidence": 0.87
  },
  "predictions": [
    {
      "action": "PROVIDE_REFLECTION",
      "confidence": 0.72,
      "expected_outcome": "Guardian finds response valuable"
    },
    {
      "action": "REQUEST_CLARIFICATION",
      "confidence": 0.38,
      "expected_outcome": "Guardian provides more context"
    }
  ],
  "selected_action": "PROVIDE_REFLECTION",
  "selection_type": "Type1",
  "response": {
    "timestamp": "2026-03-29T14:15:30Z",
    "content": "Learning happens when...",
    "confidence": 0.76
  },
  "outcome": {
    "guardian_feedback": "That's a good observation",
    "feedback_type": "CONFIRMATION",
    "drive_shifts": [
      { "drive": "satisfaction", "shift": +0.15 },
      { "drive": "social", "shift": +0.10 }
    ]
  }
}
```

**CANON Alignment:** Standard 2 (Contingency)
- Every input → action → outcome is traceable
- Guardian can verify contingencies are real, not superstitious

---

## Authentication & Rate Limiting

All endpoints require:
```
Authorization: Bearer {guardian_token}
```

Rate limits:
- WebSocket subscriptions: 1 per guardian session
- REST queries: 100 requests/minute
- Graph queries: 10/minute (expensive)

---

## Error Responses

All endpoints return errors with CANON context:

```json
{
  "error": "low_confidence_node",
  "message": "Node 'X' has confidence 0.38 (below 0.50 threshold). Cannot be used for decision-making.",
  "confidence": 0.38,
  "provenance": "LLM_GENERATED",
  "suggestion": "Provide guardian feedback to increase confidence"
}
```

---

**This guide is a living document.**
Use it to validate architecture decisions during the detailed design phase.
All endpoints must pass the CANON compliance checklist before implementation.
