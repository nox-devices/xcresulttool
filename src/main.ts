import * as artifact from '@actions/artifact'
import * as core from '@actions/core'
import * as exec from '@actions/exec'
import * as github from '@actions/github'
import * as os from 'os'
import * as path from 'path'
import {Formatter} from './formatter'
import {Octokit} from '@octokit/action'
import {glob} from 'glob'
import {promises} from 'fs'
const {stat} = promises

async function run(): Promise<void> {
  try {
    const inputPaths = core.getMultilineInput('path')
    const showPassedTests = core.getBooleanInput('show-passed-tests')
    const showCodeCoverage = core.getBooleanInput('show-code-coverage')
    let uploadBundles = core.getInput('upload-bundles').toLowerCase()
    if (uploadBundles === 'true') {
      uploadBundles = 'always'
    } else if (uploadBundles === 'false') {
      uploadBundles = 'never'
    }

    const bundlePaths: string[] = []
    for (const checkPath of inputPaths) {
      try {
        await stat(checkPath)
        bundlePaths.push(checkPath)
      } catch (error) {
        core.error((error as Error).message)
      }
    }
    let bundlePath = path.join(os.tmpdir(), 'Merged.xcresult')
    if (inputPaths.length > 1) {
      await mergeResultBundle(bundlePaths, bundlePath)
    } else {
      const inputPath = inputPaths[0]
      await stat(inputPath)
      bundlePath = inputPath
    }

    const formatter = new Formatter(bundlePath)
    const report = await formatter.format({
      showPassedTests,
      showCodeCoverage
    })

    if (core.getInput('token')) {
      await core.summary.addRaw(report.reportSummary).write()

      const octokit = new Octokit()

      const owner = github.context.repo.owner
      const repo = github.context.repo.repo

      const pr = github.context.payload.pull_request
      const sha = (pr && pr.head.sha) || github.context.sha

      const charactersLimit = 65535
      let title = core.getInput('title')
      if (title.length > charactersLimit) {
        core.warning(
          `The 'title' will be truncated because the character limit (${charactersLimit}) exceeded.`
        )
        title = title.substring(0, charactersLimit - 100)
      }
      let reportSummary = report.reportSummary
      if (reportSummary.length > charactersLimit) {
        reportSummary = reportSummary.substring(0, charactersLimit - 1000)
        core.warning(
          `The 'summary' will be truncated to ${reportSummary.length} because the character limit (${charactersLimit}) exceeded.`
        )
      }
      let reportDetail = report.reportDetail
      if (reportDetail.length > charactersLimit) {
        core.warning(
          `The 'text' will be truncated because the character limit (${charactersLimit}) exceeded.`
        )
        reportDetail = reportDetail.substring(0, charactersLimit - 1000)
      }

      if (report.annotations.length > 50) {
        core.warning(
          'Annotations that exceed the limit (50) will be truncated.'
        )
      }
      const annotations = report.annotations.slice(0, 50)
      let output = {
        title: 'Xcode test results',
        summary: reportSummary,
        text: reportDetail.trim() ? reportDetail : undefined,
        annotations
      }

      await octokit.checks.create({
        owner,
        repo,
        name: title,
        head_sha: sha,
        status: 'completed',
        conclusion: report.testStatus,
        output
      })

      if (
        uploadBundles === 'always' ||
        (uploadBundles === 'failure' && report.testStatus === 'failure')
      ) {
        for (const uploadBundlePath of inputPaths) {
          try {
            await stat(uploadBundlePath)
          } catch (error) {
            continue
          }

          const artifactClient = new artifact.DefaultArtifactClient()
          const bundleName = path.basename(uploadBundlePath)

          const artifactName = `${title} (${bundleName})`
          core.info(`Creating artifact ${artifactName}`)

          const rootDirectory = uploadBundlePath

          glob(`${uploadBundlePath}/**/*`, async (error, files) => {
            if (error) {
              core.error(error)
            }
            if (files.length) {
              core.info(`Uploading artifact ${artifactName}`)
              await artifactClient.uploadArtifact(
                artifactName,
                files,
                rootDirectory
              )
            }
          })
        }
      }
    }
  } catch (error) {
    core.setFailed((error as Error).message)
  }
}

run()

async function mergeResultBundle(
  inputPaths: string[],
  outputPath: string
): Promise<void> {
  const args = ['xcresulttool', 'merge']
    .concat(inputPaths)
    .concat(['--output-path', outputPath])

  const options = {
    silent: !core.isDebug()
  }

  await exec.exec('xcrun', args, options)
}
