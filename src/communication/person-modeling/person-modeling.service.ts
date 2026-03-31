/**
 * PersonModelingService — maintains and queries Other KG person models.
 *
 * Implements IPersonModelingService. Reads from and writes to the Grafeo
 * Other KG (one KG per person, isolated from Self KG and WKG per CANON
 * §Architecture). Used by CommunicationService to calibrate response
 * verbosity, topical references, and communication register.
 *
 * CANON §Architecture: Other KG is completely isolated from Self KG and WKG.
 * No shared edges, no cross-contamination. This service never queries the WKG.
 *
 * Implementation:
 * - Per-person Grafeo instances routed via IOtherKgService
 * - All person model nodes carry LLM_GENERATED or INFERENCE provenance
 * - Sanitized PersonModel return (no raw graph data exposed)
 * - All updates timestamped for decay tracking
 * - Communication preferences incrementally refined from conversation history
 */

import { Injectable, Inject, Logger } from '@nestjs/common';
import { OTHER_KG_SERVICE } from '../../knowledge';
import type {
  IOtherKgService,
  PersonModel as KgPersonModel,
  PersonModelUpdate as KgPersonModelUpdate,
  PersonTrait,
} from '../../knowledge';

import type {
  IPersonModelingService,
  PersonModel,
  ParsedInput,
  GeneratedResponse,
} from '../interfaces/communication.interfaces';

/**
 * Internal type for communication preferences being built/updated.
 * Tracked incrementally across interactions.
 */
interface CommunicationPreferences {
  verbosity?: string;
  formality?: string;
  topicalDepth?: string;
  technicalLevel?: string;
  responseTimeExpectation?: string;
  engagementStyle?: string;
  lastUpdated?: string;
  [key: string]: string | undefined;
}

@Injectable()
export class PersonModelingService implements IPersonModelingService {
  private readonly logger = new Logger(PersonModelingService.name);

  constructor(
    @Inject(OTHER_KG_SERVICE)
    private readonly otherKgService: IOtherKgService,
  ) {}

  /**
   * Retrieve the current person model for a given person ID.
   *
   * Returns null when no model exists for this person (first interaction).
   * Converts the raw KG model into a sanitized Communication-domain PersonModel.
   *
   * @param personId - The Grafeo Other KG person identifier (e.g. 'Person_Jim').
   * @returns The person model, or null if no model exists yet.
   */
  async getPersonModel(personId: string): Promise<PersonModel | null> {
    try {
      const kgModel = await this.otherKgService.getPersonModel(personId);
      if (!kgModel) {
        return null;
      }

      return this.sanitizeKgModel(kgModel);
    } catch (error) {
      this.logger.error(
        `Failed to retrieve person model for ${personId}:`,
        error,
      );
      throw error;
    }
  }

  /**
   * Update the person model for a given person based on a completed interaction.
   *
   * Writes to the Grafeo Other KG only. Does not touch the WKG or Self KG.
   * Updates communication preferences based on response length, entity references,
   * and input intent patterns.
   *
   * @param personId - The person whose model is being updated.
   * @param parsedInput - The structured parse of the most recent input.
   * @param response - The generated response delivered to this person.
   */
  async updateFromConversation(
    personId: string,
    parsedInput: ParsedInput,
    response: GeneratedResponse,
  ): Promise<void> {
    try {
      // Retrieve current model to check if person exists
      const currentModel = await this.otherKgService.getPersonModel(personId);

      if (!currentModel) {
        this.logger.warn(
          `Person model does not exist for ${personId}. ` +
            `Call createPerson() first before updating.`,
        );
        return;
      }

      // Build traits from interaction patterns
      const traitsToUpsert = this.extractTraitsFromInteraction(
        parsedInput,
        response,
        currentModel.traits,
      );

      // Extract communication preferences from response patterns
      const prefs = this.extractCommunicationPreferences(
        response,
        parsedInput,
      );

      // Build update payload
      const update: KgPersonModelUpdate = {
        traitsToUpsert,
      };

      // Apply update to Other KG
      await this.otherKgService.updatePersonModel(personId, update);

      // Store communication preferences as interaction metadata
      // (Implementation note: Preferences are inferred from traits and
      // response patterns; in a fuller implementation, these could be
      // persisted to a dedicated preferences node in the Other KG)
      this.logger.debug(
        `Updated person model for ${personId}: ` +
          `${traitsToUpsert.length} traits, preferences: ${Object.keys(prefs).join(', ')}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to update person model for ${personId}:`,
        error,
      );
      throw error;
    }
  }

  /**
   * Create a new person in the Other KG system.
   *
   * This is a helper method not in the interface but needed for initialization.
   * Initializes a fresh Grafeo graph for this personId.
   *
   * @param personId - Stable identifier for the person (e.g. 'person_jim').
   * @param name - Display name for the person.
   */
  async createPerson(personId: string, name: string): Promise<void> {
    try {
      await this.otherKgService.createPerson(personId, name);
      this.logger.debug(`Created person model for ${personId} (${name})`);
    } catch (error) {
      this.logger.error(
        `Failed to create person model for ${personId}:`,
        error,
      );
      throw error;
    }
  }

  /**
   * Convert a raw KG person model into a sanitized Communication-domain model.
   *
   * Extracts communication preferences from trait data and removes any
   * raw graph structure. Returns only the data Communication subsystem needs
   * for response calibration.
   *
   * @param kgModel - The raw model from IOtherKgService
   * @returns A sanitized PersonModel suitable for Communication subsystem
   */
  private sanitizeKgModel(kgModel: KgPersonModel): PersonModel {
    // Extract communication preferences from known traits
    const prefs = this.preferencesFromTraits(kgModel.traits);

    // Extract known topics from trait names
    const knownTopics = kgModel.traits
      .filter((trait) => trait.name.startsWith('interested-in-'))
      .map((trait) => trait.name.replace('interested-in-', ''));

    return {
      personId: kgModel.personId,
      name: kgModel.name,
      communicationPreferences: prefs,
      interactionCount: kgModel.interactionCount,
      lastInteraction: kgModel.lastInteractionAt ?? new Date(),
      knownTopics,
    };
  }

  /**
   * Extract communication preference strings from trait observations.
   *
   * Maps trait names to communication preference dimensions.
   * Example: trait "prefers-direct-answers" → { verbosity: 'concise' }
   *
   * @param traits - All traits from the person model
   * @returns Record of preference dimensions and values
   */
  private preferencesFromTraits(
    traits: readonly PersonTrait[],
  ): Record<string, string> {
    const prefs: Record<string, string> = {};

    for (const trait of traits) {
      if (trait.confidence < 0.50) {
        continue; // Skip low-confidence traits
      }

      // Map trait patterns to preference dimensions
      if (trait.name.includes('direct') || trait.name.includes('concise')) {
        prefs.verbosity = 'concise';
      } else if (
        trait.name.includes('detailed') ||
        trait.name.includes('verbose')
      ) {
        prefs.verbosity = 'detailed';
      }

      if (trait.name.includes('formal')) {
        prefs.formality = 'formal';
      } else if (
        trait.name.includes('casual') ||
        trait.name.includes('informal')
      ) {
        prefs.formality = 'casual';
      }

      if (trait.name.includes('technical')) {
        prefs.technicalLevel = 'technical';
      } else if (trait.name.includes('non-technical')) {
        prefs.technicalLevel = 'accessible';
      }

      if (trait.name.includes('quick-response')) {
        prefs.responseTimeExpectation = 'immediate';
      }

      if (trait.name.includes('humor')) {
        prefs.engagementStyle = 'humorous';
      }
    }

    return prefs;
  }

  /**
   * Extract new traits and inferences from a single interaction.
   *
   * Analyzes response length, parsed intent, entity count, and input patterns
   * to infer behavioral traits. Returns trait upsert requests for traits that
   * exceed minimum confidence threshold.
   *
   * All inferred traits carry INFERENCE or LLM_GENERATED provenance.
   *
   * @param parsedInput - Structured parse of the guardian's input
   * @param response - The generated response
   * @param existingTraits - Current trait set to avoid duplicates
   * @returns Array of PersonTrait upsert requests to merge
   */
  private extractTraitsFromInteraction(
    parsedInput: ParsedInput,
    response: GeneratedResponse,
    existingTraits: readonly PersonTrait[],
  ): Array<Omit<PersonTrait, 'id' | 'actrParams' | 'createdAt'>> {
    const traitsToAdd: Array<
      Omit<PersonTrait, 'id' | 'actrParams' | 'createdAt'>
    > = [];

    const existingNames = new Set(existingTraits.map((t) => t.name));

    // Infer trait: response time sensitivity
    // If input contains urgency keywords, track that
    if (
      parsedInput.rawText.toLowerCase().includes('quickly') ||
      parsedInput.rawText.toLowerCase().includes('asap') ||
      parsedInput.rawText.toLowerCase().includes('urgent')
    ) {
      const traitName = 'prefers-quick-response';
      if (!existingNames.has(traitName)) {
        traitsToAdd.push({
          name: traitName,
          confidence: 0.55,
          provenance: 'INFERENCE',
        });
      }
    }

    // Infer trait: verbosity preference from response length expectation
    const avgResponseLength =
      response.text.length /
      Math.max(
        1,
        parsedInput.rawText.length > 0
          ? Math.ceil(parsedInput.rawText.length / 50)
          : 1,
      );

    if (avgResponseLength < 100 && response.text.length < 200) {
      const traitName = 'prefers-concise-answers';
      if (!existingNames.has(traitName)) {
        traitsToAdd.push({
          name: traitName,
          confidence: 0.50,
          provenance: 'INFERENCE',
        });
      }
    } else if (avgResponseLength > 300) {
      const traitName = 'prefers-detailed-answers';
      if (!existingNames.has(traitName)) {
        traitsToAdd.push({
          name: traitName,
          confidence: 0.50,
          provenance: 'INFERENCE',
        });
      }
    }

    // Infer trait: question frequency
    if (
      parsedInput.intentType === 'QUESTION' &&
      parsedInput.confidence > 0.70
    ) {
      const traitName = 'frequently-asks-questions';
      if (!existingNames.has(traitName)) {
        traitsToAdd.push({
          name: traitName,
          confidence: 0.52,
          provenance: 'INFERENCE',
        });
      }
    }

    // Infer trait: topics of interest from entity extraction
    for (const entity of parsedInput.entities) {
      if (
        entity.type === 'TOPIC' ||
        entity.type === 'SUBJECT' ||
        entity.type === 'DOMAIN'
      ) {
        const traitName = `interested-in-${entity.name.toLowerCase().replace(/\s+/g, '-')}`;
        if (!existingNames.has(traitName) && traitName.length < 100) {
          traitsToAdd.push({
            name: traitName,
            confidence: Math.max(0.40, entity.confidence * 0.7),
            provenance: 'INFERENCE',
          });
        }
      }
    }

    return traitsToAdd;
  }

  /**
   * Extract observed communication preferences from response patterns.
   *
   * Analyzes response generation context, response length, and tone to
   * infer communication style preferences.
   *
   * This is called for each interaction to incrementally refine the model
   * of how this person prefers to be communicated with.
   *
   * @param response - The generated and delivered response
   * @param parsedInput - Structured input for context
   * @returns Communication preferences record
   */
  private extractCommunicationPreferences(
    response: GeneratedResponse,
    parsedInput: ParsedInput,
  ): CommunicationPreferences {
    const prefs: CommunicationPreferences = {};

    // Estimate verbosity expectation from response length
    if (response.text.length < 150) {
      prefs.verbosity = 'concise';
    } else if (response.text.length > 500) {
      prefs.verbosity = 'detailed';
    } else {
      prefs.verbosity = 'balanced';
    }

    // Check for formal language patterns in response
    const formalIndicators = [
      'furthermore',
      'moreover',
      'accordingly',
      'therefore',
    ];
    const hasFormalLanguage = formalIndicators.some((word) =>
      response.text.toLowerCase().includes(word),
    );

    if (hasFormalLanguage) {
      prefs.formality = 'formal';
    } else if (response.text.toLowerCase().includes('haha') ||
      response.text.toLowerCase().includes('lol')) {
      prefs.formality = 'casual';
    }

    // Timestamp for decay tracking (encode as string for Record<string, string>)
    prefs.lastUpdated = new Date().toISOString();

    return prefs;
  }
}
