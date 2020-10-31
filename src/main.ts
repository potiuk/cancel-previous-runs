import * as github from '@actions/github'
import * as core from '@actions/core'
import * as rest from '@octokit/rest'

/**
 Those are the cancellable event types tht we know about
 */
const CANCELLABLE_EVENT_TYPES = [
  'push',
  'pull_request',
  'workflow_run',
  'schedule',
  'workflow_dispatch'
]

/**
 * Those are different modes for cancelling
 */
enum CancelMode {
  DUPLICATES = 'duplicates',
  ALL_DUPLICATES = 'allDuplicates',
  SELF = 'self',
  FAILED_JOBS = 'failedJobs',
  NAMED_JOBS = 'namedJobs'
}

/**
 * Stores information uniquely identifying the run by it's triggering source:
 * It is the workflow id, Head Repo and Branch the change originates from and event name that originates it.
 *
 * All Runs coming from the same Pull Request share the same Source Group. Also all pushes to master
 * share the same Source Group
 */
interface WorkflowRunSourceGroup {
  workflowId: number | string
  headRepo: string
  headBranch: string
  eventName: string
}

/**
 * Stores information about the owner and repository used, as well as octokit object that is used for
 * authentication.
 */
interface RepositoryInfo {
  octokit: github.GitHub
  owner: string
  repo: string
}

/**
 * Stores information about the workflow info that triggered the current workflow.
 */
interface TriggeringWorkflowInfo {
  headRepo: string
  headBranch: string
  headSha: string
  eventName: string
  mergeCommitSha: string | null
  pullRequest: rest.PullsListResponseItem | null
}

/**
 * Converts the source of a run object into a string that can be used as map key in maps where we keep
 * arrays of runs per source group
 * @param sourceGroup the object identifying the source of the run (Pull Request, Master Push)
 * @returns the unique string id for the source group
 */
function getSourceGroupId(sourceGroup: WorkflowRunSourceGroup): string {
  return `:${sourceGroup.workflowId}:${sourceGroup.headRepo}:${sourceGroup.headBranch}:${sourceGroup.eventName}`
}

/**
 * Creates query parameters selecting all runs that share the same source group as we have. This can
 * be used to select duplicates of my own run.
 *
 * @param repositoryInfo - information about the repository used
 * @param status - status of the run that we are querying for
 * @param mySourceGroup - source group of the originating run
 * @return query parameters merged with the listWorkflowRuns criteria
 */
function createListRunsQueryRunsSameSource(
  repositoryInfo: RepositoryInfo,
  status: string,
  mySourceGroup: WorkflowRunSourceGroup
): rest.RequestOptions {
  const request = {
    owner: repositoryInfo.owner,
    repo: repositoryInfo.repo,
    // eslint-disable-next-line @typescript-eslint/camelcase
    workflow_id: mySourceGroup.workflowId,
    status,
    branch: mySourceGroup.headBranch,
    event: mySourceGroup.eventName
  }
  return repositoryInfo.octokit.actions.listWorkflowRuns.endpoint.merge(request)
}
/**
 * Creates query parameters selecting only specific run Id.
 * @param repositoryInfo - information about the repository used
 * @param status - status of the run that we are querying for
 * @param workflowId - Id of the workflow to retrieve
 * @param runId - run Id to retrieve
 * @return query parameters merged with the listWorkflowRuns criteria
 */
function createListRunsQuerySpecificRunId(
  repositoryInfo: RepositoryInfo,
  status: string,
  workflowId: number | string,
  runId: number
): rest.RequestOptions {
  const request = {
    owner: repositoryInfo.owner,
    repo: repositoryInfo.repo,
    // eslint-disable-next-line @typescript-eslint/camelcase
    workflow_id: workflowId,
    status,
    // eslint-disable-next-line @typescript-eslint/camelcase
    run_id: runId.toString()
  }
  return repositoryInfo.octokit.actions.listWorkflowRuns.endpoint.merge(request)
}

/**
 * Creates query parameters selecting all run Ids for specified workflow Id.
 * @param repositoryInfo - information about the repository used
 * @param status - status of the run that we are querying for
 * @param workflowId - Id of the workflow to retrieve
 * @return query parameters merged with the listWorkflowRuns criteria
 */
function createListRunsQueryAllRuns(
  repositoryInfo: RepositoryInfo,
  status: string,
  workflowId: number | string
): rest.RequestOptions {
  const request = {
    owner: repositoryInfo.owner,
    repo: repositoryInfo.repo,
    // eslint-disable-next-line @typescript-eslint/camelcase
    workflow_id: workflowId,
    status
  }
  return repositoryInfo.octokit.actions.listWorkflowRuns.endpoint.merge(request)
}

/**
 * Creates query parameters selecting all jobs for specified run Id.
 * @param repositoryInfo - information about the repository used
 * @param runId - Id of the run to retrieve jobs for
 * @return query parameters merged with the listJobsForWorkflowRun criteria
 */
function createJobsForWorkflowRunQuery(
  repositoryInfo: RepositoryInfo,
  runId: number
): rest.RequestOptions {
  const request = {
    owner: repositoryInfo.owner,
    repo: repositoryInfo.repo,
    // eslint-disable-next-line @typescript-eslint/camelcase
    run_id: runId
  }
  return repositoryInfo.octokit.actions.listJobsForWorkflowRun.endpoint.merge(
    request
  )
}

/**
 * Returns true if the string matches any of the regexps in array of regexps
 * @param stringToMatch string to match
 * @param regexps array of regexp to match the string against
 * @return true if there is a match
 */
function matchInArray(stringToMatch: string, regexps: string[]): boolean {
  for (const regexp of regexps) {
    if (stringToMatch.match(regexp)) {
      return true
    }
  }
  return false
}

/**
 * Returns true if the runId specified has jobs matching the regexp and optionally checks if those
 * jobs are failed.
 * * If checkIfFailed is False, it returns true if any of the job name for the run match any of the regexps
 * * Id checkIfFailed is True, it returns true if any of the matching jobs have status 'failed'
 * @param repositoryInfo - information about the repository used
 * @param runId - Id of the run to retrieve jobs for
 * @param jobNameRegexps - array of job name regexps
 * @param checkIfFailed - whether to check the 'failed' status of matched jobs
 * @return true if there is a match
 */
async function jobsMatchingNames(
  repositoryInfo: RepositoryInfo,
  runId: number,
  jobNameRegexps: string[],
  checkIfFailed: boolean
): Promise<boolean> {
  const listJobs = createJobsForWorkflowRunQuery(repositoryInfo, runId)
  if (checkIfFailed) {
    core.info(
      `\nChecking if runId ${runId} has job names matching any of the ${jobNameRegexps} that failed\n`
    )
  } else {
    core.info(
      `\nChecking if runId ${runId} has job names matching any of the ${jobNameRegexps}\n`
    )
  }
  for await (const item of repositoryInfo.octokit.paginate.iterator(listJobs)) {
    for (const job of item.data.jobs) {
      core.info(`    The job name: ${job.name}, Conclusion: ${job.conclusion}`)
      if (matchInArray(job.name, jobNameRegexps)) {
        if (checkIfFailed) {
          // Only fail the build if one of the matching jobs fail
          if (job.conclusion === 'failure') {
            core.info(
              `    The Job ${job.name} matches one of the ${jobNameRegexps} regexps and it failed.` +
                ` Cancelling run.`
            )
            return true
          } else {
            core.info(
              `    The Job ${job.name} matches one of the ${jobNameRegexps} regexps but it did not fail. ` +
                ` So far, so good.`
            )
          }
        } else {
          // Fail the build if any of the job names match
          core.info(
            `    The Job ${job.name} matches one of the ${jobNameRegexps} regexps. Cancelling run.`
          )
          return true
        }
      }
    }
  }
  return false
}

/**
 * Retrieves workflowId from the workflow URL.
 * @param workflowUrl workflow URL to retrieve the ID from
 * @return numerical workflow id
 */
function retrieveWorkflowIdFromUrl(workflowUrl: string): number {
  const workflowIdString = workflowUrl.split('/').pop() || ''
  if (!(workflowIdString.length > 0)) {
    throw new Error('Could not resolve workflow')
  }
  return parseInt(workflowIdString)
}

/**
 * Returns workflowId of the runId specified
 * @param repositoryInfo - information about the repository used
 * @param runId - Id of the run to retrieve jobs for
 * @return workflow ID for the run id
 */
async function getWorkflowId(
  repositoryInfo: RepositoryInfo,
  runId: number
): Promise<number> {
  const reply = await repositoryInfo.octokit.actions.getWorkflowRun({
    owner: repositoryInfo.owner,
    repo: repositoryInfo.repo,
    // eslint-disable-next-line @typescript-eslint/camelcase
    run_id: runId
  })
  core.info(`The source run ${runId} is in ${reply.data.workflow_url} workflow`)
  return retrieveWorkflowIdFromUrl(reply.data.workflow_url)
}

/**
 * Returns workflow runs matching the callable adding query criteria
 * @param repositoryInfo - information about the repository used
 * @param statusValues - array of string status values for runs that we are interested at
 * @param cancelMode - which cancel mode the query is about
 * @param createListRunQuery - what is the callable criteria selection
 * @return map of workflow run items indexed by the workflow run number
 */
async function getWorkflowRuns(
  repositoryInfo: RepositoryInfo,
  statusValues: string[],
  cancelMode: CancelMode,
  createListRunQuery: CallableFunction
): Promise<Map<number, rest.ActionsListWorkflowRunsResponseWorkflowRunsItem>> {
  const workflowRuns = new Map<
    number,
    rest.ActionsListWorkflowRunsResponseWorkflowRunsItem
  >()
  for (const status of statusValues) {
    const listRuns = await createListRunQuery(status)
    for await (const item of repositoryInfo.octokit.paginate.iterator(
      listRuns
    )) {
      // There is some sort of bug where the pagination URLs point to a
      // different endpoint URL which trips up the resulting representation
      // In that case, fallback to the actual REST 'workflow_runs' property
      const elements =
        item.data.length === undefined ? item.data.workflow_runs : item.data
      for (const element of elements) {
        workflowRuns.set(element.run_number, element)
      }
    }
  }
  core.info(`\nFound runs: ${Array.from(workflowRuns).map(t => t[0])}\n`)
  return workflowRuns
}

/**
 * True if the request is candidate for cancelling in case of duplicate deletion
 * @param runItem item to check
 * @param headRepo head Repo that we are checking against
 * @param cancelFutureDuplicates whether future duplicates are being cancelled
 * @param sourceRunId the source Run Id that originates the request
 * @return true if we determine that the run Id should be cancelled
 */
function isCandidateForCancellingDuplicate(
  runItem: rest.ActionsListWorkflowRunsResponseWorkflowRunsItem,
  headRepo: string,
  cancelFutureDuplicates: boolean,
  sourceRunId: number
): boolean {
  const runHeadRepo = runItem.head_repository.full_name
  if (headRepo !== undefined && runHeadRepo !== headRepo) {
    core.info(
      `\nThe run ${runItem.id} is from a different ` +
        `repo: ${runHeadRepo} (expected ${headRepo}). Not cancelling it\n`
    )
    return false
  }
  if (cancelFutureDuplicates) {
    core.info(
      `\nCancel Future Duplicates: Returning run id that might be duplicate or my own run: ${runItem.id}.\n`
    )
    return true
  } else {
    if (runItem.id === sourceRunId) {
      core.info(`\nThis is my own run ${runItem.id}. Not returning myself!\n`)
      return false
    } else if (runItem.id > sourceRunId) {
      core.info(
        `\nThe run ${runItem.id} is started later than my own run ${sourceRunId}. Not returning it\n`
      )
      return false
    }
    core.info(`\nFound duplicate of my own run: ${runItem.id}.\n`)
    return true
  }
}

/**
 * Should the run is candidate for cancelling in SELF cancelling mode?
 * @param runItem run item
 * @param sourceRunId source run id
 * @return true if the run item is self
 */
function isCandidateForCancellingSelf(
  runItem: rest.ActionsListWorkflowRunsResponseWorkflowRunsItem,
  sourceRunId: number
): boolean {
  if (runItem.id === sourceRunId) {
    core.info(`\nReturning the "source" run: ${runItem.id}.\n`)
    return true
  } else {
    return false
  }
}

/**
 * Should the run is candidate for cancelling in naming job cancelling mode?
 * @param repositoryInfo - information about the repository used
 * @param runItem run item
 * @param jobNamesRegexps array of regexps to match job names against
 * @return true if the run item contains jobs with names matching the pattern
 */
async function isCandidateForCancellingNamedJobs(
  repositoryInfo: RepositoryInfo,
  runItem: rest.ActionsListWorkflowRunsResponseWorkflowRunsItem,
  jobNamesRegexps: string[]
): Promise<boolean> {
  // Cancel all jobs that have failed jobs (no matter when started)
  if (
    await jobsMatchingNames(repositoryInfo, runItem.id, jobNamesRegexps, false)
  ) {
    core.info(
      `\nSome jobs have matching names in ${runItem.id} . Returning it.\n`
    )
    return true
  } else {
    core.info(`\nNone of the jobs match name in ${runItem.id}. Returning it.\n`)
    return false
  }
}

/**
 * Should the run is candidate for cancelling in failed job cancelling mode?
 * @param repositoryInfo - information about the repository used
 * @param runItem run item
 * @param jobNamesRegexps array of regexps to match job names against
 * @return true if the run item contains failed jobs with names matching the pattern
 */
async function isCandidateForCancellingFailedJobs(
  repositoryInfo: RepositoryInfo,
  runItem: rest.ActionsListWorkflowRunsResponseWorkflowRunsItem,
  jobNamesRegexps: string[]
): Promise<boolean> {
  // Cancel all jobs that have failed jobs (no matter when started)
  if (
    await jobsMatchingNames(repositoryInfo, runItem.id, jobNamesRegexps, true)
  ) {
    core.info(
      `\nSome matching named jobs failed in ${runItem.id} . Cancelling it.\n`
    )
    return true
  } else {
    core.info(
      `\nNone of the matching jobs failed in ${runItem.id}. Not cancelling it.\n`
    )
    return false
  }
}

/**
 * Determines whether the run is candidate to be cancelled depending on the mode used
 * @param repositoryInfo - information about the repository used
 * @param runItem - run item
 * @param headRepo - head repository
 * @param cancelMode - cancel mode
 * @param cancelFutureDuplicates - whether to cancel future duplicates
 * @param sourceRunId - what is the source run id
 * @param jobNamesRegexps - what are the regexps for job names
 * @param skipEventTypes - which events should be skipped
 * @return true if the run id is candidate for cancelling
 */
async function isCandidateForCancelling(
  repositoryInfo: RepositoryInfo,
  runItem: rest.ActionsListWorkflowRunsResponseWorkflowRunsItem,
  headRepo: string,
  cancelMode: CancelMode,
  cancelFutureDuplicates: boolean,
  sourceRunId: number,
  jobNamesRegexps: string[],
  skipEventTypes: string[]
): Promise<boolean> {
  if ('completed' === runItem.status.toString()) {
    core.info(`\nThe run ${runItem.id} is completed. Not cancelling it.\n`)
    return false
  }
  if (!CANCELLABLE_EVENT_TYPES.includes(runItem.event.toString())) {
    core.info(
      `\nThe run ${runItem.id} is (${runItem.event} event - not ` +
        `in ${CANCELLABLE_EVENT_TYPES}). Not cancelling it.\n`
    )
    return false
  }
  if (skipEventTypes.includes(runItem.event.toString())) {
    core.info(
      `\nThe run ${runItem.id} is (${runItem.event} event - ` +
        `it is in skipEventTypes ${skipEventTypes}). Not cancelling it.\n`
    )
    return false
  }
  if (cancelMode === CancelMode.FAILED_JOBS) {
    return await isCandidateForCancellingFailedJobs(
      repositoryInfo,
      runItem,
      jobNamesRegexps
    )
  } else if (cancelMode === CancelMode.NAMED_JOBS) {
    return await isCandidateForCancellingNamedJobs(
      repositoryInfo,
      runItem,
      jobNamesRegexps
    )
  } else if (cancelMode === CancelMode.SELF) {
    return isCandidateForCancellingSelf(runItem, sourceRunId)
  } else if (cancelMode === CancelMode.DUPLICATES) {
    return isCandidateForCancellingDuplicate(
      runItem,
      headRepo,
      cancelFutureDuplicates,
      sourceRunId
    )
  } else if (cancelMode === CancelMode.ALL_DUPLICATES) {
    core.info(
      `Returning candidate ${runItem.id} for "all_duplicates" cancelling.`
    )
    return true
  } else {
    throw Error(
      `\nWrong cancel mode ${cancelMode}! This should never happen.\n`
    )
  }
}

/**
 * Cancels the specified workflow run.
 * @param repositoryInfo - information about the repository used
 * @param runId - run Id to cancel
 */
async function cancelRun(
  repositoryInfo: RepositoryInfo,
  runId: number
): Promise<void> {
  let reply
  try {
    reply = await repositoryInfo.octokit.actions.cancelWorkflowRun({
      owner: repositoryInfo.owner,
      repo: repositoryInfo.repo,
      // eslint-disable-next-line @typescript-eslint/camelcase
      run_id: runId
    })
    core.info(`\nThe run ${runId} cancelled, status = ${reply.status}\n`)
  } catch (error) {
    core.warning(
      `\nCould not cancel run ${runId}: [${error.status}] ${error.message}\n`
    )
  }
}

/**
 * Returns map of workflow run items matching the criteria specified group by workflow run id
 * @param repositoryInfo - information about the repository used
 * @param statusValues - status values we want to check
 * @param cancelMode - cancel mode to use
 * @param sourceWorkflowId - source workflow id
 * @param sourceRunId - source run id
 * @param sourceEventName - name of the source event
 * @param mySourceGroup - source of the run that originated it
 * @return map of the run items matching grouped by workflow run id
 */
async function getWorkflowRunsMatchingCriteria(
  repositoryInfo: RepositoryInfo,
  statusValues: string[],
  cancelMode:
    | CancelMode
    | CancelMode.DUPLICATES
    | CancelMode.ALL_DUPLICATES
    | CancelMode.FAILED_JOBS
    | CancelMode.NAMED_JOBS,
  sourceWorkflowId: number | string,
  sourceRunId: number,
  sourceEventName: string,
  mySourceGroup: WorkflowRunSourceGroup
): Promise<Map<number, rest.ActionsListWorkflowRunsResponseWorkflowRunsItem>> {
  return await getWorkflowRuns(
    repositoryInfo,
    statusValues,
    cancelMode,
    function(status: string) {
      if (cancelMode === CancelMode.SELF) {
        core.info(
          `\nFinding runs for my own run: Owner: ${repositoryInfo.owner}, Repo: ${repositoryInfo.repo}, ` +
            `Workflow ID:${sourceWorkflowId}, Source Run id: ${sourceRunId}\n`
        )
        return createListRunsQuerySpecificRunId(
          repositoryInfo,
          status,
          sourceWorkflowId,
          sourceRunId
        )
      } else if (
        cancelMode === CancelMode.FAILED_JOBS ||
        cancelMode === CancelMode.NAMED_JOBS ||
        cancelMode === CancelMode.ALL_DUPLICATES
      ) {
        core.info(
          `\nFinding runs for all runs: Owner: ${repositoryInfo.owner}, Repo: ${repositoryInfo.repo}, ` +
            `Status: ${status} Workflow ID:${sourceWorkflowId}\n`
        )
        return createListRunsQueryAllRuns(
          repositoryInfo,
          status,
          sourceWorkflowId
        )
      } else if (cancelMode === CancelMode.DUPLICATES) {
        core.info(
          `\nFinding duplicate runs: Owner: ${repositoryInfo.owner}, Repo: ${repositoryInfo.repo}, ` +
            `Status: ${status} Workflow ID:${sourceWorkflowId}, Head Branch: ${mySourceGroup.headBranch},` +
            `Event name: ${sourceEventName}\n`
        )
        return createListRunsQueryRunsSameSource(
          repositoryInfo,
          status,
          mySourceGroup
        )
      } else {
        throw Error(
          `\nWrong cancel mode ${cancelMode}! This should never happen.\n`
        )
      }
    }
  )
}

/**
 * Finds pull request matching its headRepo, headBranch and headSha
 * @param repositoryInfo - information about the repository used
 * @param headRepo - head repository from which Pull Request comes
 * @param headBranch - head branch from which Pull Request comes
 * @param headSha - sha for the head of the incoming Pull request
 */
async function findPullRequest(
  repositoryInfo: RepositoryInfo,
  headRepo: string,
  headBranch: string,
  headSha: string
): Promise<rest.PullsListResponseItem | null> {
  // Finds Pull request for this workflow run
  core.info(
    `\nFinding PR request id for: owner: ${repositoryInfo.owner}, Repo:${repositoryInfo.repo},` +
      ` Head:${headRepo}:${headBranch}.\n`
  )
  const pullRequests = await repositoryInfo.octokit.pulls.list({
    owner: repositoryInfo.owner,
    repo: repositoryInfo.repo,
    head: `${headRepo}:${headBranch}`
  })
  for (const pullRequest of pullRequests.data) {
    core.info(
      `\nComparing: ${pullRequest.number} sha: ${pullRequest.head.sha} with expected: ${headSha}.\n`
    )
    if (pullRequest.head.sha === headSha) {
      core.info(`\nFound PR: ${pullRequest.number}\n`)
      return pullRequest
    }
  }
  core.info(`\nCould not find the PR for this build :(\n`)
  return null
}

/**
 * Finds pull request id for the run item.
 * @param repositoryInfo - information about the repository used
 * @param runItem - run Item that the pull request should be found for
 * @return pull request number to notify (or undefined if not found)
 */
async function findPullRequestForRunItem(
  repositoryInfo: RepositoryInfo,
  runItem: rest.ActionsListWorkflowRunsResponseWorkflowRunsItem
): Promise<number | undefined> {
  const pullRequest = await findPullRequest(
    repositoryInfo,
    runItem.head_repository.owner.login,
    runItem.head_branch,
    runItem.head_sha
  )
  if (pullRequest) {
    return pullRequest.number
  }
  return undefined
}

/**
 * Maps found workflow runs into groups - filters out the workflows that are not eligible for canceling
 * (depends on cancel Mode) and assigns each workflow to groups - where workflow runs from the
 * same group are put together in one array - in a map indexed by the source group id.
 *
 * @param repositoryInfo - information about the repository used
 * @param headRepo - head repository the event comes from
 * @param cancelMode - cancel mode to use
 * @param cancelFutureDuplicates - whether to cancel future duplicates
 * @param sourceRunId - source run id for the run
 * @param jobNameRegexps - regexps for job names
 * @param skipEventTypes - array of event names to skip
 * @param workflowRuns - map of workflow runs found
 * @parm map where key is the source group id and value is array of workflow run item candidates to cancel
 */
async function filterAndMapWorkflowRunsToGroups(
  repositoryInfo: RepositoryInfo,
  headRepo: string,
  cancelMode: CancelMode,
  cancelFutureDuplicates: boolean,
  sourceRunId: number,
  jobNameRegexps: string[],
  skipEventTypes: string[],
  workflowRuns: Map<
    number,
    rest.ActionsListWorkflowRunsResponseWorkflowRunsItem
  >
): Promise<
  Map<string, rest.ActionsListWorkflowRunsResponseWorkflowRunsItem[]>
> {
  const mapOfWorkflowRunCandidates = new Map()
  for (const [key, runItem] of workflowRuns) {
    core.info(
      `\nChecking run number: ${key}, RunId: ${runItem.id}, Url: ${runItem.url}. Status ${runItem.status},` +
        ` Created at ${runItem.created_at}\n`
    )
    if (
      await isCandidateForCancelling(
        repositoryInfo,
        runItem,
        headRepo,
        cancelMode,
        cancelFutureDuplicates,
        sourceRunId,
        jobNameRegexps,
        skipEventTypes
      )
    ) {
      const candidateSourceGroup: WorkflowRunSourceGroup = {
        workflowId: retrieveWorkflowIdFromUrl(runItem.workflow_url),
        headBranch: runItem.head_branch,
        headRepo: runItem.head_repository.full_name,
        eventName: runItem.event
      }
      const sourceGroupId = getSourceGroupId(candidateSourceGroup)
      let workflowRunArray:
        | rest.ActionsListWorkflowRunsResponseWorkflowRunsItem[]
        | undefined = mapOfWorkflowRunCandidates.get(sourceGroupId)
      if (workflowRunArray === undefined) {
        workflowRunArray = []
        mapOfWorkflowRunCandidates.set(sourceGroupId, workflowRunArray)
      }
      core.info(
        `The candidate ${runItem.id} has been added to ${sourceGroupId} group of candidates`
      )
      workflowRunArray.push(runItem)
    }
  }
  return mapOfWorkflowRunCandidates
}

/**
 * Add specified comment to Pull Request
 * @param repositoryInfo - information about the repository used
 * @param pullRequestNumber - number of pull request
 * @param comment - comment to add
 */
async function addCommentToPullRequest(
  repositoryInfo: RepositoryInfo,
  pullRequestNumber: number,
  comment: string
): Promise<void> {
  core.info(`\nNotifying PR: ${pullRequestNumber} with '${comment}'.\n`)
  await repositoryInfo.octokit.issues.createComment({
    owner: repositoryInfo.owner,
    repo: repositoryInfo.repo,
    // eslint-disable-next-line @typescript-eslint/camelcase
    issue_number: pullRequestNumber,
    body: comment
  })
}

/**
 * Notifies PR about cancelling
 * @param repositoryInfo - information about the repository used
 * @param selfRunId - my own run id
 * @param pullRequestNumber - number of pull request
 * @param reason reason for canceling
 */
async function notifyPR(
  repositoryInfo: RepositoryInfo,
  selfRunId: number,
  pullRequestNumber: number,
  reason: string
): Promise<void> {
  const selfWorkflowRunUrl =
    `https://github.com/${repositoryInfo.owner}/${repositoryInfo.repo}` +
    `/actions/runs/${selfRunId}`
  await addCommentToPullRequest(
    repositoryInfo,
    pullRequestNumber,
    `[The Workflow run](${selfWorkflowRunUrl}) is cancelling this PR. ${reason}`
  )
}

/**
 * Cancels all runs in the specified group of runs.
 * @param repositoryInfo - information about the repository used
 * @param sortedRunItems - items sorted in descending order (descending order by created_at)
 * @param notifyPRCancel - whether to notify the PR when cancelling
 * @param selfRunId - what is the self run id
 * @param sourceGroupId - what is the source group id
 * @param reason - reason for canceling
 */
async function cancelAllRunsInTheSourceGroup(
  repositoryInfo: RepositoryInfo,
  sortedRunItems: rest.ActionsListWorkflowRunsResponseWorkflowRunsItem[],
  notifyPRCancel: boolean,
  selfRunId: number,
  sourceGroupId: string,
  reason: string
): Promise<number[]> {
  core.info(
    `\n###### Cancelling runs for ${sourceGroupId} starting from the most recent  ##########\n` +
      `\n     Number of runs to cancel: ${sortedRunItems.length}\n`
  )
  const cancelledRuns: number[] = []
  for (const runItem of sortedRunItems) {
    if (notifyPRCancel && runItem.event === 'pull_request') {
      const pullRequestNumber = await findPullRequestForRunItem(
        repositoryInfo,
        runItem
      )
      if (pullRequestNumber !== undefined) {
        core.info(
          `\nNotifying PR: ${pullRequestNumber} (runItem: ${runItem}) with: ${reason}\n`
        )
        await notifyPR(repositoryInfo, selfRunId, pullRequestNumber, reason)
      }
    }
    core.info(`\nCancelling run: ${runItem}.\n`)
    await cancelRun(repositoryInfo, runItem.id)
    cancelledRuns.push(runItem.id)
  }
  core.info(
    `\n######  Finished cancelling runs for ${sourceGroupId} ##########\n`
  )
  return cancelledRuns
}

/**
 * Cancels found runs in a smart way. It takes all the found runs group by the source group, sorts them
 * descending according to create date in each of the source groups and cancels them in that order -
 * optionally skipping the first found run in each source group in case of duplicates.
 *
 * @param repositoryInfo - information about the repository used
 * @param mapOfWorkflowRunsCandidatesToCancel map of all workflow run candidates
 * @param cancelMode - cancel mode
 * @param cancelFutureDuplicates - whether to cancel future duplicates
 * @param notifyPRCancel - whether to notify PRs with comments
 * @param selfRunId - self run Id
 * @param reason - reason for canceling
 */
async function cancelTheRunsPerGroup(
  repositoryInfo: RepositoryInfo,
  mapOfWorkflowRunsCandidatesToCancel: Map<
    string,
    rest.ActionsListWorkflowRunsResponseWorkflowRunsItem[]
  >,
  cancelMode: CancelMode,
  cancelFutureDuplicates: boolean,
  notifyPRCancel: boolean,
  selfRunId: number,
  reason: string
): Promise<number[]> {
  const cancelledRuns: number[] = []
  for (const [
    sourceGroupId,
    candidatesArray
  ] of mapOfWorkflowRunsCandidatesToCancel) {
    // Sort from most recent date - this way we always kill current one at the end (if we kill it at all)
    const sortedRunItems = candidatesArray.sort((runItem1, runItem2) =>
      runItem2.created_at.localeCompare(runItem1.created_at)
    )
    if (sortedRunItems.length > 0) {
      if (
        (cancelMode === CancelMode.DUPLICATES && cancelFutureDuplicates) ||
        cancelMode === CancelMode.ALL_DUPLICATES
      ) {
        core.info(
          `\nSkipping the first run (${sortedRunItems[0].id}) of all the matching ` +
            `duplicates for '${sourceGroupId}'. This one we are going to leave in peace!\n`
        )
        sortedRunItems.shift()
      }
      if (sortedRunItems.length === 0) {
        core.info(`\nNo duplicates to cancel for ${sourceGroupId}!\n`)
        continue
      }
      cancelledRuns.push(
        ...(await cancelAllRunsInTheSourceGroup(
          repositoryInfo,
          sortedRunItems,
          notifyPRCancel,
          selfRunId,
          sourceGroupId,
          reason
        ))
      )
    } else {
      core.info(
        `\n######  There are no runs to cancel for ${sourceGroupId} ##########\n`
      )
    }
  }
  return cancelledRuns
}

/**
 * Find and cancels runs based on the criteria chosen.
 * @param repositoryInfo - information about the repository used
 * @param selfRunId - number of own run id
 * @param sourceWorkflowId - source workflow id that triggered the workflow
 *        (might be different than self for workflow_run)
 * @param sourceRunId - source run id that triggered the workflow
 *        (might be different than self for workflow_run)
 * @param headRepo - head repository that triggered the workflow (repo from which PR came)
 * @param headBranch - branch of the PR that triggered the workflow (when it is triggered by PR)
 * @param sourceEventName - name of the event that triggered the workflow
 *        (different than self event name for workflow_run)
 * @param cancelMode - cancel mode used
 * @param cancelFutureDuplicates - whether to cancel future duplicates for duplicate cancelling
 * @param notifyPRCancel - whether to notify in PRs about cancelling
 * @param notifyPRMessageStart - whether to notify PRs when the action starts
 * @param jobNameRegexps - array of regular expressions to match hob names in case of named modes
 * @param skipEventTypes - array of event names that should be skipped
 * @param reason - reason for cancelling
 * @return array of canceled workflow run ids
 */
async function findAndCancelRuns(
  repositoryInfo: RepositoryInfo,
  selfRunId: number,
  sourceWorkflowId: number | string,
  sourceRunId: number,
  headRepo: string,
  headBranch: string,
  sourceEventName: string,
  cancelMode: CancelMode,
  cancelFutureDuplicates: boolean,
  notifyPRCancel: boolean,
  notifyPRMessageStart: string,
  jobNameRegexps: string[],
  skipEventTypes: string[],
  reason: string
): Promise<number[]> {
  const statusValues = ['queued', 'in_progress']
  const mySourceGroup: WorkflowRunSourceGroup = {
    headBranch,
    headRepo,
    eventName: sourceEventName,
    workflowId: sourceWorkflowId
  }
  const workflowRuns = await getWorkflowRunsMatchingCriteria(
    repositoryInfo,
    statusValues,
    cancelMode,
    sourceWorkflowId,
    sourceRunId,
    sourceEventName,
    mySourceGroup
  )
  const mapOfWorkflowRunsCandidatesToCancel = await filterAndMapWorkflowRunsToGroups(
    repositoryInfo,
    headRepo,
    cancelMode,
    cancelFutureDuplicates,
    sourceRunId,
    jobNameRegexps,
    skipEventTypes,
    workflowRuns
  )
  return await cancelTheRunsPerGroup(
    repositoryInfo,
    mapOfWorkflowRunsCandidatesToCancel,
    cancelMode,
    cancelFutureDuplicates,
    notifyPRCancel,
    selfRunId,
    reason
  )
}

/**
 * Returns environment variable that is required - throws error if it is not defined.
 * @param key key for the env variable
 * @return value of the env variable
 */
function getRequiredEnv(key: string): string {
  const value = process.env[key]
  if (value === undefined) {
    const message = `${key} was not defined.`
    throw new Error(message)
  }
  return value
}

/**
 * Gets origin of the runId - if this is a workflow run, it returns the information about the source run
 * @param repositoryInfo - information about the repository used
 * @param runId - run id of the run to check
 * @return information about the triggering workflow
 */
async function getOrigin(
  repositoryInfo: RepositoryInfo,
  runId: number
): Promise<TriggeringWorkflowInfo> {
  const reply = await repositoryInfo.octokit.actions.getWorkflowRun({
    owner: repositoryInfo.owner,
    repo: repositoryInfo.repo,
    // eslint-disable-next-line @typescript-eslint/camelcase
    run_id: runId
  })
  const sourceRun = reply.data
  core.info(
    `Source workflow: Head repo: ${sourceRun.head_repository.full_name}, ` +
      `Head branch: ${sourceRun.head_branch} ` +
      `Event: ${sourceRun.event}, Head sha: ${sourceRun.head_sha}, url: ${sourceRun.url}`
  )
  let pullRequest: rest.PullsListResponseItem | null = null
  if (sourceRun.event === 'pull_request') {
    pullRequest = await findPullRequest(
      repositoryInfo,
      sourceRun.head_repository.owner.login,
      sourceRun.head_branch,
      sourceRun.head_sha
    )
  }

  return {
    headRepo: reply.data.head_repository.full_name,
    headBranch: reply.data.head_branch,
    headSha: reply.data.head_sha,
    mergeCommitSha: pullRequest ? pullRequest.merge_commit_sha : null,
    pullRequest: pullRequest ? pullRequest : null,
    eventName: reply.data.event
  }
}

/**
 * Performs the actual cancelling.
 *
 * @param repositoryInfo - information about the repository used
 * @param selfRunId - number of own run id
 * @param sourceWorkflowId - source workflow id that triggered the workflow
 *        (might be different than self for workflow_run)
 * @param sourceRunId - source run id that triggered the workflow
 *        (might be different than self for workflow_run)
 * @param headRepo - head repository that triggered the workflow (repo from which PR came)
 * @param headBranch - branch of the PR that triggered the workflow (when it is triggered by PR)
 * @param sourceEventName - name of the event that triggered the workflow
 *        (different than self event name for workflow_run)
 * @param cancelMode - cancel mode used
 * @param cancelFutureDuplicates - whether to cancel future duplicates for duplicate cancelling
 * @param notifyPRCancel - whether to notify in PRs about cancelling
 * @param notifyPRCancelMessage - message to send when cancelling the PR (overrides default message
 *        generated automatically)
 * @param notifyPRMessageStart - whether to notify PRs when the action starts
 * @param jobNameRegexps - array of regular expressions to match hob names in case of named modes
 * @param skipEventTypes - array of event names that should be skipped
 */
async function performCancelJob(
  repositoryInfo: RepositoryInfo,
  selfRunId: number,
  sourceWorkflowId: number | string,
  sourceRunId: number,
  headRepo: string,
  headBranch: string,
  sourceEventName: string,
  cancelMode: CancelMode,
  notifyPRCancel: boolean,
  notifyPRCancelMessage: string,
  notifyPRMessageStart: string,
  jobNameRegexps: string[],
  skipEventTypes: string[],
  cancelFutureDuplicates: boolean
): Promise<number[]> {
  core.info(
    '\n###################################################################################\n'
  )
  core.info(
    `All parameters: owner: ${repositoryInfo.owner}, repo: ${repositoryInfo.repo}, run id: ${sourceRunId}, ` +
      `head repo ${headRepo}, headBranch: ${headBranch}, ` +
      `sourceEventName: ${sourceEventName}, cancelMode: ${cancelMode}, jobNames: ${jobNameRegexps}`
  )
  core.info(
    '\n###################################################################################\n'
  )
  let reason = ''
  if (cancelMode === CancelMode.SELF) {
    core.info(
      `# Cancelling source run: ${sourceRunId} for workflow ${sourceWorkflowId}.`
    )
    reason = notifyPRCancelMessage
      ? notifyPRCancelMessage
      : `The job has been cancelled by another workflow.`
  } else if (cancelMode === CancelMode.FAILED_JOBS) {
    core.info(
      `# Cancel all runs for workflow ${sourceWorkflowId} where job names matching ${jobNameRegexps} failed.`
    )
    reason = `It has some failed jobs matching ${jobNameRegexps}.`
  } else if (cancelMode === CancelMode.NAMED_JOBS) {
    core.info(
      `# Cancel all runs for workflow ${sourceWorkflowId} have job names matching ${jobNameRegexps}.`
    )
    reason = `It has jobs matching ${jobNameRegexps}.`
  } else if (cancelMode === CancelMode.DUPLICATES) {
    core.info(
      `# Cancel duplicate runs for workflow ${sourceWorkflowId} for same triggering branch as own run Id.`
    )
    reason = `It is an earlier duplicate of ${sourceWorkflowId} run.`
  } else if (cancelMode === CancelMode.ALL_DUPLICATES) {
    core.info(
      `# Cancel all duplicates runs started for workflow ${sourceWorkflowId}.`
    )
    reason = `It is an earlier duplicate of ${sourceWorkflowId} run.`
  } else {
    throw Error(`Wrong cancel mode ${cancelMode}! This should never happen.`)
  }
  core.info(
    '\n###################################################################################\n'
  )

  return await findAndCancelRuns(
    repositoryInfo,
    selfRunId,
    sourceWorkflowId,
    sourceRunId,
    headRepo,
    headBranch,
    sourceEventName,
    cancelMode,
    cancelFutureDuplicates,
    notifyPRCancel,
    notifyPRMessageStart,
    jobNameRegexps,
    skipEventTypes,
    reason
  )
}

/**
 * Retrieves information about source workflow Id. Either from the current event or from the workflow
 * nme specified. If the file name is not specified, the workflow to act on is either set to self event
 * or in case of workflow_run event - to the workflow id that triggered the 'workflow_run' event.
 *
 * @param repositoryInfo - information about the repository used
 * @param workflowFileName - optional workflow file name
 * @param sourceRunId - source run id of the workfow
 * @param selfRunId - self run id
 * @return workflow id that is associate with the workflow we are going to act on.
 */
async function retrieveWorkflowId(
  repositoryInfo: RepositoryInfo,
  workflowFileName: string | null,
  sourceRunId: number,
  selfRunId: number
): Promise<string | number> {
  let sourceWorkflowId
  if (workflowFileName) {
    sourceWorkflowId = workflowFileName
    core.info(
      `\nFinding runs for another workflow found by ${workflowFileName} name: ${sourceWorkflowId}\n`
    )
  } else {
    sourceWorkflowId = await getWorkflowId(repositoryInfo, sourceRunId)
    if (sourceRunId === selfRunId) {
      core.info(`\nFinding runs for my own workflow ${sourceWorkflowId}\n`)
    } else {
      core.info(`\nFinding runs for source workflow ${sourceWorkflowId}\n`)
    }
  }
  return sourceWorkflowId
}
/**
 * Sets output but also prints the output value in the logs.
 *
 * @param name name of the output
 * @param value value of the output
 */
function verboseOutput(name: string, value: string): void {
  core.info(`Setting output: ${name}: ${value}`)
  core.setOutput(name, value)
}

/**
 * Performs sanity check of the parameters passed. Some of the parameter combinations do not work so they
 * are verified and in case od unexpected combination found, approrpriate error is raised.
 *
 * @param eventName - name of the event to act on
 * @param sourceRunId - run id of the triggering event
 * @param selfRunId - our own run id
 * @param cancelMode - cancel mode used
 * @param cancelFutureDuplicates - whether future duplicate cancelling is enabled
 * @param jobNameRegexps - array of regular expression of job names
 */
function performSanityChecks(
  eventName: string,
  sourceRunId: number,
  selfRunId: number,
  cancelMode: CancelMode,
  cancelFutureDuplicates: boolean,
  jobNameRegexps: string[]
): void {
  if (
    eventName === 'workflow_run' &&
    sourceRunId === selfRunId &&
    cancelMode === CancelMode.DUPLICATES
  ) {
    throw Error(
      `You cannot run "workflow_run" in ${cancelMode} cancelMode without "sourceId" input.` +
        'It will likely not work as you intended - it will cancel runs which are not duplicates!' +
        'See the docs for details.'
    )
  }

  if (
    jobNameRegexps.length > 0 &&
    [
      CancelMode.DUPLICATES,
      CancelMode.SELF,
      CancelMode.ALL_DUPLICATES
    ].includes(cancelMode)
  ) {
    throw Error(`You cannot specify jobNames on ${cancelMode} cancelMode.`)
  }

  if (cancelMode === CancelMode.ALL_DUPLICATES && !cancelFutureDuplicates) {
    throw Error(
      `The  ${cancelMode} cancelMode has to have cancelFutureDuplicates set to true.`
    )
  }
}

/**
 * Produces basic outputs for the action. This does not include cancelled workflow run id - those are
 * set after cancelling is done.
 *
 * @param triggeringWorkflowInfo
 */
function produceBasicOutputs(
  triggeringWorkflowInfo: TriggeringWorkflowInfo
): void {
  verboseOutput('sourceHeadRepo', triggeringWorkflowInfo.headRepo)
  verboseOutput('sourceHeadBranch', triggeringWorkflowInfo.headBranch)
  verboseOutput('sourceHeadSha', triggeringWorkflowInfo.headSha)
  verboseOutput('sourceEvent', triggeringWorkflowInfo.eventName)
  verboseOutput(
    'pullRequestNumber',
    triggeringWorkflowInfo.pullRequest
      ? triggeringWorkflowInfo.pullRequest.number.toString()
      : ''
  )
  verboseOutput(
    'mergeCommitSha',
    triggeringWorkflowInfo.mergeCommitSha
      ? triggeringWorkflowInfo.mergeCommitSha
      : ''
  )
  verboseOutput(
    'targetCommitSha',
    triggeringWorkflowInfo.mergeCommitSha
      ? triggeringWorkflowInfo.mergeCommitSha
      : triggeringWorkflowInfo.headSha
  )
}

/**
 * Notifies the PR that the action has started.
 *
 * @param repositoryInfo information about the repository
 * @param triggeringWorkflowInfo information about the triggering workflow
 * @param sourceRunId run id of the source workflow
 * @param selfRunId self run id
 * @param notifyPRMessageStart whether to notify about the start of the action
 */
async function notifyActionStart(
  repositoryInfo: RepositoryInfo,
  triggeringWorkflowInfo: TriggeringWorkflowInfo,
  sourceRunId: number,
  selfRunId: number,
  notifyPRMessageStart: string
): Promise<void> {
  if (notifyPRMessageStart && triggeringWorkflowInfo.pullRequest) {
    const selfWorkflowRunUrl =
      `https://github.com/${repositoryInfo.owner}/${repositoryInfo.repo}` +
      `/actions/runs/${selfRunId}`
    await repositoryInfo.octokit.issues.createComment({
      owner: repositoryInfo.owner,
      repo: repositoryInfo.repo,
      // eslint-disable-next-line @typescript-eslint/camelcase
      issue_number: triggeringWorkflowInfo.pullRequest.number,
      body: `${notifyPRMessageStart} [The workflow run](${selfWorkflowRunUrl})`
    })
  }
}

/**
 * Main run method that does everything :)
 */
async function run(): Promise<void> {
  const token = core.getInput('token', {required: true})
  const octokit = new github.GitHub(token)
  const selfRunId = parseInt(getRequiredEnv('GITHUB_RUN_ID'))
  const repository = getRequiredEnv('GITHUB_REPOSITORY')
  const eventName = getRequiredEnv('GITHUB_EVENT_NAME')
  const cancelMode =
    (core.getInput('cancelMode') as CancelMode) || CancelMode.DUPLICATES
  const notifyPRCancel =
    (core.getInput('notifyPRCancel') || 'false').toLowerCase() === 'true'
  const notifyPRCancelMessage = core.getInput('notifyPRCancelMessage')
  const notifyPRMessageStart = core.getInput('notifyPRMessageStart')
  const sourceRunId = parseInt(core.getInput('sourceRunId')) || selfRunId
  const jobNameRegexpsString = core.getInput('jobNameRegexps')
  const cancelFutureDuplicates =
    (core.getInput('cancelFutureDuplicates') || 'true').toLowerCase() === 'true'
  const jobNameRegexps = jobNameRegexpsString
    ? JSON.parse(jobNameRegexpsString)
    : []

  const skipEventTypesString = core.getInput('skipEventTypes')
  const skipEventTypes = skipEventTypesString
    ? JSON.parse(skipEventTypesString)
    : []
  const workflowFileName = core.getInput('workflowFileName')

  const [owner, repo] = repository.split('/')

  const repositoryInfo: RepositoryInfo = {
    octokit,
    owner,
    repo
  }
  core.info(
    `\nGetting workflow id for source run id: ${sourceRunId}, owner: ${owner}, repo: ${repo},` +
      ` skipEventTypes: ${skipEventTypes}\n`
  )
  const sourceWorkflowId = await retrieveWorkflowId(
    repositoryInfo,
    workflowFileName,
    sourceRunId,
    selfRunId
  )

  performSanityChecks(
    eventName,
    sourceRunId,
    selfRunId,
    cancelMode,
    cancelFutureDuplicates,
    jobNameRegexps
  )

  core.info(
    `Repository: ${repository}, Owner: ${owner}, Repo: ${repo}, ` +
      `Event name: ${eventName}, CancelMode: ${cancelMode}, ` +
      `sourceWorkflowId: ${sourceWorkflowId}, sourceRunId: ${sourceRunId}, selfRunId: ${selfRunId}, ` +
      `jobNames: ${jobNameRegexps}`
  )

  const triggeringWorkflowInfo = await getOrigin(repositoryInfo, sourceRunId)
  produceBasicOutputs(triggeringWorkflowInfo)

  await notifyActionStart(
    repositoryInfo,
    triggeringWorkflowInfo,
    sourceRunId,
    selfRunId,
    notifyPRMessageStart
  )

  const cancelledRuns = await performCancelJob(
    repositoryInfo,
    selfRunId,
    sourceWorkflowId,
    sourceRunId,
    triggeringWorkflowInfo.headRepo,
    triggeringWorkflowInfo.headBranch,
    triggeringWorkflowInfo.eventName,
    cancelMode,
    notifyPRCancel,
    notifyPRCancelMessage,
    notifyPRMessageStart,
    jobNameRegexps,
    skipEventTypes,
    cancelFutureDuplicates
  )

  verboseOutput('cancelledRuns', JSON.stringify(cancelledRuns))
}

run()
  .then(() =>
    core.info('\n############### Cancel complete ##################\n')
  )
  .catch(e => core.setFailed(e.message))
