import * as github from '@actions/github'
import * as core from '@actions/core'
import * as rest from '@octokit/rest'
import * as treemap from 'jstreemap'

const CANCELLABLE_RUNS = [
  'push',
  'pull_request',
  'workflow_run',
  'schedule',
  'workflow_dispatch'
]

enum CancelMode {
  DUPLICATES = 'duplicates',
  SELF = 'self',
  FAILED_JOBS = 'failedJobs',
  NAMED_JOBS = 'namedJobs'
}

function createListRunsQueryOtherRuns(
  octokit: github.GitHub,
  owner: string,
  repo: string,
  status: string,
  workflowId: number,
  headBranch: string,
  eventName: string
): rest.RequestOptions {
  const request = {
    owner,
    repo,
    // eslint-disable-next-line @typescript-eslint/camelcase
    workflow_id: workflowId,
    status,
    branch: headBranch,
    event: eventName
  }
  return octokit.actions.listWorkflowRuns.endpoint.merge(request)
}

function createListRunsQueryMyOwnRun(
  octokit: github.GitHub,
  owner: string,
  repo: string,
  status: string,
  workflowId: number,
  runId: number
): rest.RequestOptions {
  const request = {
    owner,
    repo,
    // eslint-disable-next-line @typescript-eslint/camelcase
    workflow_id: workflowId,
    status,
    // eslint-disable-next-line @typescript-eslint/camelcase
    run_id: runId.toString()
  }
  return octokit.actions.listWorkflowRuns.endpoint.merge(request)
}

function createListRunsQueryAllRuns(
  octokit: github.GitHub,
  owner: string,
  repo: string,
  status: string,
  workflowId: number
): rest.RequestOptions {
  const request = {
    owner,
    repo,
    // eslint-disable-next-line @typescript-eslint/camelcase
    workflow_id: workflowId,
    status
  }
  return octokit.actions.listWorkflowRuns.endpoint.merge(request)
}

function createJobsForWorkflowRunQuery(
  octokit: github.GitHub,
  owner: string,
  repo: string,
  runId: number
): rest.RequestOptions {
  const request = {
    owner,
    repo,
    // eslint-disable-next-line @typescript-eslint/camelcase
    run_id: runId
  }
  return octokit.actions.listJobsForWorkflowRun.endpoint.merge(request)
}

function matchInArray(s: string, regexps: string[]): boolean {
  for (const regexp of regexps) {
    if (s.match(regexp)) {
      return true
    }
  }
  return false
}

async function jobsMatchingNames(
  octokit: github.GitHub,
  owner: string,
  repo: string,
  runId: number,
  jobNameRegexps: string[],
  checkIfFailed: boolean
): Promise<boolean> {
  const listJobs = createJobsForWorkflowRunQuery(octokit, owner, repo, runId)
  if (checkIfFailed) {
    core.info(
      `\nChecking if runId ${runId} has job names matching any of the ${jobNameRegexps} that failed\n`
    )
  } else {
    core.info(
      `\nChecking if runId ${runId} has job names matching any of the ${jobNameRegexps}\n`
    )
  }
  for await (const item of octokit.paginate.iterator(listJobs)) {
    for (const job of item.data.jobs) {
      core.info(`    The job name: ${job.name}, Conclusion: ${job.conclusion}`)
      if (matchInArray(job.name, jobNameRegexps)) {
        if (checkIfFailed) {
          // Only fail the build if one of the matching jobs fail
          if (job.conclusion === 'failure') {
            core.info(
              `    The Job ${job.name} matches one of the ${jobNameRegexps} regexps and it failed. Cancelling run.`
            )
            return true
          } else {
            core.info(
              `    The Job ${job.name} matches one of the ${jobNameRegexps} regexps but it did not fail. So far, so good.`
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

async function getWorkflowId(
  octokit: github.GitHub,
  runId: number,
  owner: string,
  repo: string
): Promise<number> {
  const reply = await octokit.actions.getWorkflowRun({
    owner,
    repo,
    // eslint-disable-next-line @typescript-eslint/camelcase
    run_id: runId
  })
  core.info(`The source run ${runId} is in ${reply.data.workflow_url} workflow`)
  const workflowIdString = reply.data.workflow_url.split('/').pop() || ''
  if (!(workflowIdString.length > 0)) {
    throw new Error('Could not resolve workflow')
  }
  return parseInt(workflowIdString)
}

async function getWorkflowRuns(
  octokit: github.GitHub,
  statusValues: string[],
  cancelMode: CancelMode,
  createListRunQuery: CallableFunction
): Promise<
  treemap.TreeMap<number, rest.ActionsListWorkflowRunsResponseWorkflowRunsItem>
> {
  const workflowRuns = new treemap.TreeMap<
    number,
    rest.ActionsListWorkflowRunsResponseWorkflowRunsItem
  >()
  for (const status of statusValues) {
    const listRuns = await createListRunQuery(status)
    for await (const item of octokit.paginate.iterator(listRuns)) {
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

async function shouldBeCancelled(
  octokit: github.GitHub,
  owner: string,
  repo: string,
  runItem: rest.ActionsListWorkflowRunsResponseWorkflowRunsItem,
  headRepo: string,
  cancelMode: CancelMode,
  sourceRunId: number,
  jobNamesRegexps: string[],
  skipEventTypes: string[]
): Promise<boolean> {
  if ('completed' === runItem.status.toString()) {
    core.info(`\nThe run ${runItem.id} is completed. Not cancelling it.\n`)
    return false
  }
  if (!CANCELLABLE_RUNS.includes(runItem.event.toString())) {
    core.info(
      `\nThe run ${runItem.id} is (${runItem.event} event - not in ${CANCELLABLE_RUNS}). Not cancelling it.\n`
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
    // Cancel all jobs that have failed jobs (no matter when started)
    if (
      await jobsMatchingNames(
        octokit,
        owner,
        repo,
        runItem.id,
        jobNamesRegexps,
        true
      )
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
  } else if (cancelMode === CancelMode.NAMED_JOBS) {
    // Cancel all jobs that have failed jobs (no matter when started)
    if (
      await jobsMatchingNames(
        octokit,
        owner,
        repo,
        runItem.id,
        jobNamesRegexps,
        false
      )
    ) {
      core.info(
        `\nSome jobs have matching names in ${runItem.id} . Cancelling it.\n`
      )
      return true
    } else {
      core.info(
        `\nNone of the jobs match name in ${runItem.id}. Not cancelling it.\n`
      )
      return false
    }
  } else if (cancelMode === CancelMode.SELF) {
    if (runItem.id === sourceRunId) {
      core.info(`\nCancelling the "source" run: ${runItem.id}.\n`)
      return true
    } else {
      return false
    }
  } else if (cancelMode === CancelMode.DUPLICATES) {
    const runHeadRepo = runItem.head_repository.full_name
    if (headRepo !== undefined && runHeadRepo !== headRepo) {
      core.info(
        `\nThe run ${runItem.id} is from a different ` +
          `repo: ${runHeadRepo} (expected ${headRepo}). Not cancelling it\n`
      )
      return false
    }
    if (runItem.id === sourceRunId) {
      core.info(
        `\nThis is my own run ${runItem.id}. I have self-preservation mechanism. Not cancelling myself!\n`
      )
      return false
    } else if (runItem.id > sourceRunId) {
      core.info(
        `\nThe run ${runItem.id} is started later than mt own run ${sourceRunId}. Not cancelling it\n`
      )
      return false
    } else {
      core.info(`\nCancelling duplicate of my own run: ${runItem.id}.\n`)
      return true
    }
  } else {
    throw Error(
      `\nWrong cancel mode ${cancelMode}! This should never happen.\n`
    )
  }
}

async function cancelRun(
  octokit: github.GitHub,
  owner: string,
  repo: string,
  runId: number
): Promise<void> {
  let reply
  try {
    reply = await octokit.actions.cancelWorkflowRun({
      owner,
      repo,
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

async function findAndCancelRuns(
  octokit: github.GitHub,
  selfRunId: number,
  sourceWorkflowId: number,
  sourceRunId: number,
  owner: string,
  repo: string,
  headRepo: string,
  headBranch: string,
  sourceEventName: string,
  cancelMode: CancelMode,
  notifyPRCancel: boolean,
  notifyPRMessageStart: string,
  jobNameRegexps: string[],
  skipEventTypes: string[],
  reason: string
): Promise<number[]> {
  const statusValues = ['queued', 'in_progress']
  const workflowRuns = await getWorkflowRuns(
    octokit,
    statusValues,
    cancelMode,
    function(status: string) {
      if (cancelMode === CancelMode.SELF) {
        core.info(
          `\nFinding runs for my own run: Owner: ${owner}, Repo: ${repo}, ` +
            `Workflow ID:${sourceWorkflowId}, Source Run id: ${sourceRunId}\n`
        )
        return createListRunsQueryMyOwnRun(
          octokit,
          owner,
          repo,
          status,
          sourceWorkflowId,
          sourceRunId
        )
      } else if (
        cancelMode === CancelMode.FAILED_JOBS ||
        cancelMode === CancelMode.NAMED_JOBS
      ) {
        core.info(
          `\nFinding runs for all runs: Owner: ${owner}, Repo: ${repo}, Status: ${status} ` +
            `Workflow ID:${sourceWorkflowId}\n`
        )
        return createListRunsQueryAllRuns(
          octokit,
          owner,
          repo,
          status,
          sourceWorkflowId
        )
      } else if (cancelMode === CancelMode.DUPLICATES) {
        core.info(
          `\nFinding duplicate runs: Owner: ${owner}, Repo: ${repo}, Status: ${status} ` +
            `Workflow ID:${sourceWorkflowId}, Head Branch: ${headBranch},` +
            `Event name: ${sourceEventName}\n`
        )
        return createListRunsQueryOtherRuns(
          octokit,
          owner,
          repo,
          status,
          sourceWorkflowId,
          headBranch,
          sourceEventName
        )
      } else {
        throw Error(
          `\nWrong cancel mode ${cancelMode}! This should never happen.\n`
        )
      }
    }
  )
  const idsToCancel: number[] = []
  const pullRequestToNotify: number[] = []
  for (const [key, runItem] of workflowRuns) {
    core.info(
      `\nChecking run number: ${key}, RunId: ${runItem.id}, Url: ${runItem.url}. Status ${runItem.status}\n`
    )
    if (
      await shouldBeCancelled(
        octokit,
        owner,
        repo,
        runItem,
        headRepo,
        cancelMode,
        sourceRunId,
        jobNameRegexps,
        skipEventTypes
      )
    ) {
      if (notifyPRCancel && runItem.event === 'pull_request') {
        const pullRequest = await findPullRequest(
          octokit,
          owner,
          repo,
          runItem.head_repository.owner.login,
          runItem.head_branch,
          runItem.head_sha
        )
        if (pullRequest) {
          pullRequestToNotify.push(pullRequest.number)
        }
      }
      idsToCancel.push(runItem.id)
    }
  }
  // Sort from smallest number - this way we always kill current one at the end (if we kill it at all)
  const sortedIdsToCancel = idsToCancel.sort((id1, id2) => id1 - id2)
  if (sortedIdsToCancel.length > 0) {
    core.info(
      '\n######  Cancelling runs starting from the oldest  ##########\n' +
        `\n     Runs to cancel: ${sortedIdsToCancel.length}\n` +
        `\n     PRs to notify: ${pullRequestToNotify.length}\n`
    )
    for (const runId of sortedIdsToCancel) {
      core.info(`\nCancelling run: ${runId}.\n`)
      await cancelRun(octokit, owner, repo, runId)
    }
    for (const pullRequestNumber of pullRequestToNotify) {
      const selfWorkflowRunUrl = `https://github.com/${owner}/${repo}/actions/runs/${selfRunId}`
      await addCommentToPullRequest(
        octokit,
        owner,
        repo,
        pullRequestNumber,
        `[The Workflow run](${selfWorkflowRunUrl}) is cancelling this PR. ${reason}`
      )
    }
    core.info(
      '\n######  Finished cancelling runs                  ##########\n'
    )
  } else {
    core.info(
      '\n######  There are no runs to cancel!              ##########\n'
    )
  }
  return sortedIdsToCancel
}

function getRequiredEnv(key: string): string {
  const value = process.env[key]
  if (value === undefined) {
    const message = `${key} was not defined.`
    throw new Error(message)
  }
  return value
}

async function addCommentToPullRequest(
  octokit: github.GitHub,
  owner: string,
  repo: string,
  pullRequestNumber: number,
  comment: string
): Promise<void> {
  core.info(`\nNotifying PR: ${pullRequestNumber} with '${comment}'.\n`)
  await octokit.issues.createComment({
    owner,
    repo,
    // eslint-disable-next-line @typescript-eslint/camelcase
    issue_number: pullRequestNumber,
    body: comment
  })
}

async function findPullRequest(
  octokit: github.GitHub,
  owner: string,
  repo: string,
  headRepo: string,
  headBranch: string,
  headSha: string
): Promise<rest.PullsListResponseItem | null> {
  // Finds Pull request for this workflow run
  core.info(
    `\nFinding PR request id for: owner: ${owner}, Repo:${repo}, Head:${headRepo}:${headBranch}.\n`
  )
  const pullRequests = await octokit.pulls.list({
    owner,
    repo,
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

async function getOrigin(
  octokit: github.GitHub,
  runId: number,
  owner: string,
  repo: string
): Promise<
  [string, string, string, string, string, rest.PullsListResponseItem | null]
> {
  const reply = await octokit.actions.getWorkflowRun({
    owner,
    repo,
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
      octokit,
      owner,
      repo,
      sourceRun.head_repository.owner.login,
      sourceRun.head_branch,
      sourceRun.head_sha
    )
  }

  return [
    reply.data.head_repository.full_name,
    reply.data.head_branch,
    reply.data.event,
    reply.data.head_sha,
    pullRequest ? pullRequest.merge_commit_sha : '',
    pullRequest
  ]
}

async function performCancelJob(
  octokit: github.GitHub,
  selfRunId: number,
  sourceWorkflowId: number,
  sourceRunId: number,
  owner: string,
  repo: string,
  headRepo: string,
  headBranch: string,
  sourceEventName: string,
  cancelMode: CancelMode,
  notifyPRCancel: boolean,
  notifyPRCancelMessage: string,
  notifyPRMessageStart: string,
  jobNameRegexps: string[],
  skipEventTypes: string[]
): Promise<number[]> {
  core.info(
    '\n###################################################################################\n'
  )
  core.info(
    `All parameters: owner: ${owner}, repo: ${repo}, run id: ${sourceRunId}, ` +
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
      `# Cancel duplicate runs started before ${sourceRunId} for workflow ${sourceWorkflowId}.`
    )
    reason = `It in earlier duplicate of ${sourceWorkflowId} run.`
  } else {
    throw Error(`Wrong cancel mode ${cancelMode}! This should never happen.`)
  }
  core.info(
    '\n###################################################################################\n'
  )

  return await findAndCancelRuns(
    octokit,
    selfRunId,
    sourceWorkflowId,
    sourceRunId,
    owner,
    repo,
    headRepo,
    headBranch,
    sourceEventName,
    cancelMode,
    notifyPRCancel,
    notifyPRMessageStart,
    jobNameRegexps,
    skipEventTypes,
    reason
  )
}

function verboseOutput(name: string, value: string): void {
  core.info(`Setting output: ${name}: ${value}`)
  core.setOutput(name, value)
}

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
  const jobNameRegexps = jobNameRegexpsString
    ? JSON.parse(jobNameRegexpsString)
    : []

  const skipEventTypesString = core.getInput('skipEventTypes')
  const skipEventTypes = skipEventTypesString
    ? JSON.parse(skipEventTypesString)
    : []

  const [owner, repo] = repository.split('/')

  core.info(
    `\nGetting workflow id for source run id: ${sourceRunId}, owner: ${owner}, repo: ${repo},` +
      ` skipEventTypes: ${skipEventTypes}\n`
  )
  const sourceWorkflowId = await getWorkflowId(
    octokit,
    sourceRunId,
    owner,
    repo
  )
  core.info(
    `Repository: ${repository}, Owner: ${owner}, Repo: ${repo}, ` +
      `Event name: ${eventName}, CancelMode: ${cancelMode}, ` +
      `sourceWorkflowId: ${sourceWorkflowId}, sourceRunId: ${sourceRunId}, selfRunId: ${selfRunId}, ` +
      `jobNames: ${jobNameRegexps}`
  )

  if (sourceRunId === selfRunId) {
    core.info(`\nFinding runs for my own workflow ${sourceWorkflowId}\n`)
  } else {
    core.info(`\nFinding runs for source workflow ${sourceWorkflowId}\n`)
  }

  if (
    jobNameRegexps.length > 0 &&
    [CancelMode.DUPLICATES, CancelMode.SELF].includes(cancelMode)
  ) {
    throw Error(`You cannot specify jobNames on ${cancelMode} cancelMode.`)
  }

  if (eventName === 'workflow_run' && sourceRunId === selfRunId) {
    if (cancelMode === CancelMode.DUPLICATES)
      throw Error(
        `You cannot run "workflow_run" in ${cancelMode} cancelMode without "sourceId" input.` +
          'It will likely not work as you intended - it will cancel runs which are not duplicates!' +
          'See the docs for details.'
      )
  }

  const [
    headRepo,
    headBranch,
    sourceEventName,
    headSha,
    mergeCommitSha,
    pullRequest
  ] = await getOrigin(octokit, sourceRunId, owner, repo)

  verboseOutput('sourceHeadRepo', headRepo)
  verboseOutput('sourceHeadBranch', headBranch)
  verboseOutput('sourceHeadSha', headSha)
  verboseOutput('sourceEvent', sourceEventName)
  verboseOutput(
    'pullRequestNumber',
    pullRequest ? pullRequest.number.toString() : ''
  )
  verboseOutput('mergeCommitSha', mergeCommitSha)
  verboseOutput('targetCommitSha', pullRequest ? mergeCommitSha : headSha)

  const selfWorkflowRunUrl = `https://github.com/${owner}/${repo}/actions/runs/${selfRunId}`
  if (notifyPRMessageStart && pullRequest) {
    await octokit.issues.createComment({
      owner,
      repo,
      // eslint-disable-next-line @typescript-eslint/camelcase
      issue_number: pullRequest.number,
      body: `${notifyPRMessageStart} [The workflow run](${selfWorkflowRunUrl})`
    })
  }

  const cancelledRuns = await performCancelJob(
    octokit,
    selfRunId,
    sourceWorkflowId,
    sourceRunId,
    owner,
    repo,
    headRepo,
    headBranch,
    sourceEventName,
    cancelMode,
    notifyPRCancel,
    notifyPRCancelMessage,
    notifyPRMessageStart,
    jobNameRegexps,
    skipEventTypes
  )

  verboseOutput('cancelledRuns', JSON.stringify(cancelledRuns))
}

run()
  .then(() =>
    core.info('\n############### Cancel complete ##################\n')
  )
  .catch(e => core.setFailed(e.message))
