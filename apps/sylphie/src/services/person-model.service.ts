/**
 * PersonModelService — Other Evaluation (person modeling).
 *
 * Per sylphie2.png architecture: "Person Jim → Other Evaluation" feeds into
 * Communication so responses are calibrated to the person being spoken to.
 *
 * This service maintains a model of who Sylphie is talking to — their name,
 * known facts, interaction preferences, and conversation patterns. The model
 * is included in the LLM system prompt so Sylphie responds person-aware.
 *
 * Storage: Grafeo (Other KG) via Neo4j OTHER instance. Currently in-memory
 * until Grafeo is fully wired.
 *
 * CANON §Communication: Person modeling enables personalized, authentic
 * expression. Without it, Sylphie treats every conversation partner the same.
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import { Neo4jService, Neo4jInstanceName, type PersonModelSummary } from '@sylphie/shared';

/** In-memory person record before Grafeo integration. */
interface PersonRecord {
  personId: string;
  knownFacts: string[];
  interactionCount: number;
  lastInteractionAt: Date;
  preferredTopics: string[];
  interactionSummary: string;
}

@Injectable()
export class PersonModelService {
  private readonly logger = new Logger(PersonModelService.name);

  /** In-memory person store. Keyed by personId. */
  private readonly persons = new Map<string, PersonRecord>();

  /** The current active person (who Sylphie is talking to right now). */
  private activePersonId: string | null = null;

  constructor(
    @Optional() private readonly neo4j: Neo4jService | null,
  ) {}

  /**
   * Get the person model for the given person ID.
   *
   * Returns a PersonModelSummary for LLM context assembly, or null if
   * no model exists for this person.
   */
  getPersonModel(personId: string): PersonModelSummary | null {
    const record = this.persons.get(personId);
    if (!record) return null;

    return {
      personId: record.personId,
      knownFacts: record.knownFacts,
      interactionSummary: record.interactionSummary,
    };
  }

  /**
   * Get the model for the currently active person, if any.
   */
  getActivePersonModel(): PersonModelSummary | null {
    if (!this.activePersonId) return null;
    return this.getPersonModel(this.activePersonId);
  }

  /**
   * Set the active person (who Sylphie is currently talking to).
   */
  setActivePerson(personId: string): void {
    this.activePersonId = personId;

    // Ensure a record exists
    if (!this.persons.has(personId)) {
      this.persons.set(personId, {
        personId,
        knownFacts: [],
        interactionCount: 0,
        lastInteractionAt: new Date(),
        preferredTopics: [],
        interactionSummary: '',
      });
      this.logger.log(`New person model created: ${personId}`);
    }
  }

  /**
   * Record an interaction with a person.
   *
   * Extracts facts from the conversation text and updates the person model.
   * Called by CommunicationService on each input/response pair.
   *
   * @param personId - The person identifier.
   * @param text     - The text content of the interaction.
   * @param role     - Whether this was user input or assistant response.
   */
  recordInteraction(
    personId: string,
    text: string,
    role: 'user' | 'assistant',
  ): void {
    let record = this.persons.get(personId);
    if (!record) {
      record = {
        personId,
        knownFacts: [],
        interactionCount: 0,
        lastInteractionAt: new Date(),
        preferredTopics: [],
        interactionSummary: '',
      };
      this.persons.set(personId, record);
    }

    record.interactionCount++;
    record.lastInteractionAt = new Date();

    // Extract simple facts from user input
    if (role === 'user') {
      const facts = extractFactsFromText(text, personId);
      for (const fact of facts) {
        if (!record.knownFacts.includes(fact)) {
          record.knownFacts.push(fact);
          this.logger.debug(`Learned about ${personId}: "${fact}"`);
        }
      }
    }

    // Update interaction summary
    record.interactionSummary =
      `${record.interactionCount} interactions. ` +
      `Last: ${record.lastInteractionAt.toISOString().split('T')[0]}. ` +
      (record.knownFacts.length > 0
        ? `Known: ${record.knownFacts.slice(-5).join('; ')}.`
        : 'No facts learned yet.');
  }

  /**
   * Get all known person IDs.
   */
  getKnownPersonIds(): string[] {
    return [...this.persons.keys()];
  }
}

// ---------------------------------------------------------------------------
// Fact extraction helper
// ---------------------------------------------------------------------------

/**
 * Extract simple facts from conversation text.
 *
 * Pattern matches common self-disclosure patterns:
 * - "My name is X" → "Name is X"
 * - "I am X" / "I'm X" → "Is X"
 * - "I like X" / "I love X" → "Likes X"
 * - "I work at X" / "I work as X" → "Works at/as X"
 */
function extractFactsFromText(text: string, personId: string): string[] {
  const facts: string[] = [];
  const lower = text.toLowerCase();

  // "My name is X"
  const nameMatch = lower.match(/my name is (\w+)/);
  if (nameMatch) {
    facts.push(`Name is ${nameMatch[1]}`);
  }

  // "I am X" / "I'm X" (occupation, state, identity)
  const iAmMatch = lower.match(/i(?:'m| am) (?:a |an )?(\w+(?:\s+\w+)?)/);
  if (iAmMatch && !['not', 'very', 'so', 'just', 'also', 'really'].includes(iAmMatch[1])) {
    facts.push(`Is ${iAmMatch[1]}`);
  }

  // "I like/love X"
  const likeMatch = lower.match(/i (?:like|love|enjoy) (.+?)(?:\.|$)/);
  if (likeMatch) {
    facts.push(`Likes ${likeMatch[1].trim().substring(0, 50)}`);
  }

  // "I work at/as X"
  const workMatch = lower.match(/i work (?:at|as|for) (.+?)(?:\.|$)/);
  if (workMatch) {
    facts.push(`Works ${workMatch[0].replace(/^i /, '').trim().substring(0, 50)}`);
  }

  return facts;
}
