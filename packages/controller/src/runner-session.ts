import {
  activitiesPermitted,
  CHAOS_PROFILES,
  chaosPermitted,
  practiceLimits,
  productionGate,
  projectDomainsAuthorised,
  type Authorisation,
  type Journey,
  type Project,
} from '@hornet-swarm/core';
import { assertAuthorisationUsable } from './authorisation.js';
import { HornetError } from './errors.js';
import { runnerFetch, runWithToken } from './runner-auth.js';

export type AuthoriseRunInput = {
  project: Project;
  auth: Authorisation;
  agentId: string;
  home: string;
  confirmProduction?: boolean;
  chaos?: { profile: string };
};

/**
 * Proof that one agent passed every authorisation gate for one project. `authorise` is the only
 * constructor, so a runner can be handed a login only inside a run that was checked first.
 */
export class AuthorisedRun {
  private constructor(
    readonly project: Project,
    readonly auth: Authorisation,
    readonly agentId: string,
    readonly home: string,
  ) {}

  /**
   * Runs the gates in order: the authorisation itself, its domains, production, practice limits,
   * and chaos, then loads the journeys and checks the activities they need. Any refusal throws.
   */
  static authorise<T>(input: AuthoriseRunInput, loadJourneys: () => { loaded: T; journeys: Journey[] }): { run: AuthorisedRun; loaded: T } {
    const { project, auth, home } = input;
    if (!input.agentId) throw new HornetError('A run needs an agent id.', 3);
    assertAuthorisationUsable(auth, home);
    const domains = projectDomainsAuthorised(project, auth);
    if (!domains.ok) throw new HornetError(domains.reason, 3);
    const production = productionGate(project, auth, Boolean(input.confirmProduction));
    if (!production.ok) throw new HornetError(production.reason, 3);
    const polite = practiceLimits(project, auth);
    if (!polite.ok) throw new HornetError(polite.reason, 3);
    if (input.chaos) {
      if (!CHAOS_PROFILES.includes(input.chaos.profile)) throw new HornetError(`unknown chaos profile: ${input.chaos.profile}. Use one of ${CHAOS_PROFILES.join(', ')}.`, 3);
      const allowed = chaosPermitted(auth, project);
      if (!allowed.ok) throw new HornetError(allowed.reason, 3);
    }
    const { loaded, journeys } = loadJourneys();
    const activities = activitiesPermitted(auth, { signIn: true, journeys });
    if (!activities.ok) throw new HornetError(activities.reason, 3);
    return { run: new AuthorisedRun(project, auth, input.agentId, home), loaded };
  }
}

/**
 * One label's runner for one job of an authorised run. `open` issues the run's control token and
 * revokes it when the job ends, so every request inside carries a token that dies with the job.
 */
export class RunnerSession {
  private located?: Promise<string>;

  private constructor(
    readonly run: AuthorisedRun,
    readonly label: string,
    private readonly locate: (projectId: string, label: string) => Promise<string>,
  ) {}

  static open<T>(run: AuthorisedRun, label: string, locate: (projectId: string, label: string) => Promise<string>, body: (session: RunnerSession) => Promise<T>): Promise<T> {
    if (!(run instanceof AuthorisedRun)) throw new HornetError('A runner session needs an authorised run.', 3);
    return runWithToken(run.project.id, label, run.home, () => body(new RunnerSession(run, label, locate)));
  }

  get projectId(): string {
    return this.run.project.id;
  }

  get home(): string {
    return this.run.home;
  }

  /** The runner's control address. A stopped runner is started the first time this is asked. */
  endpoint(): Promise<string> {
    this.located ??= this.locate(this.projectId, this.label);
    return this.located;
  }

  async fetch(path: string, init: { method: string; body?: string; signal?: AbortSignal }): Promise<Response> {
    return runnerFetch(this.projectId, await this.endpoint(), path, init, this.home, this.label);
  }
}
