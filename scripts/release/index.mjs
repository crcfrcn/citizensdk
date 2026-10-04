#!/usr/bin/env node
// RELEASE_BUILD: full; CARGO_INCREMENTAL=0

// citizensdk.sdk.release 的正式动作入口；SDK 打包逻辑只调用产品唯一真源，目录不重复包装 sdk。
import { mkdtempSync, realpathSync, lstatSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const implementations = Object.freeze({"github-release":"#!/usr/bin/env node\n\nimport { lstatSync, readFileSync } from 'node:fs';\nimport { basename } from 'node:path';\nimport { spawnSync } from 'node:child_process';\nimport { pathToFileURL } from 'node:url';\n\nconst SHA_PATTERN = /^[0-9a-f]{40}$/;\nconst REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\\/[A-Za-z0-9_.-]+$/;\nconst TAG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;\nconst READ_ATTEMPTS = 7;\nconst READ_RETRY_MS = 10_000;\n\nfunction required(condition, message) {\n  if (!condition) throw new Error(message);\n}\n\nfunction includedResponseStatus(output) {\n  const pattern = /(?:^|\\r?\\n)HTTP\\/[0-9.]+\\s+([0-9]{3})(?=[ \\t]|\\r?$)/gm;\n  let status = null;\n  for (const match of String(output || '').matchAll(pattern)) status = Number(match[1]);\n  return status;\n}\n\nfunction includedResponseBody(output) {\n  const value = String(output || '');\n  const windowsSeparator = value.lastIndexOf('\\r\\n\\r\\n');\n  if (windowsSeparator >= 0) return value.slice(windowsSeparator + 4);\n  const unixSeparator = value.lastIndexOf('\\n\\n');\n  return unixSeparator >= 0 ? value.slice(unixSeparator + 2) : '';\n}\n\nexport function gh(args, options = {}) {\n  const run = options.run || spawnSync;\n  const wait = options.wait || ((milliseconds) => {\n    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);\n  });\n  const attempts = options.retryRead ? READ_ATTEMPTS : 1;\n  for (let attempt = 1; attempt <= attempts; attempt += 1) {\n    const commandArgs = options.notFound\n      ? [...args, '--include']\n      : args;\n    if (options.notFound) {\n      required(args[0] === 'api' && !args.includes('--include'),\n        'notFound 只允许用于未带 --include 的 GitHub API 读取');\n    }\n    const result = run('gh', commandArgs, {\n      encoding: 'utf8',\n      input: options.input,\n      env: process.env,\n      maxBuffer: 16 * 1024 * 1024,\n    });\n    if (result.error) throw result.error;\n    const stdout = String(result.stdout || '');\n    const stderr = String(result.stderr || '');\n    const response = [stdout, stderr].filter(Boolean).join('\\n');\n    const responseStatus = options.notFound ? includedResponseStatus(response) : null;\n    if (result.status === 0) {\n      if (!options.notFound) return stdout.trim();\n      required(responseStatus !== null, 'GitHub API 读取缺少可核验 HTTP 状态');\n      required(responseStatus >= 200 && responseStatus < 300,\n        `GitHub API 成功进程返回了异常 HTTP 状态：${responseStatus}`);\n      return includedResponseBody(stdout).trim();\n    }\n    const detail = (stderr || stdout).trim();\n    if (options.notFound && responseStatus === 404) return null;\n    // 中文注释：只读查询可以安全重试；创建、上传、发布与删除均可能已经产生副作用，\n    // 禁止用重试掩盖权限或事务错误，必须由下方状态核对与精确回滚收口。\n    const integrationDenied = /HTTP 403:\\s*Resource not accessible by integration/i.test(detail);\n    const retryable = options.retryRead && (integrationDenied || /HTTP 5\\d\\d/i.test(detail));\n    if (!retryable || attempt === attempts) {\n      throw new Error(detail || `gh 执行失败，退出码 ${result.status}`);\n    }\n    console.error(`[GitHub] Release 只读接口暂时不可用，${READ_RETRY_MS / 1000} 秒后重试（${attempt}/${attempts - 1}）`);\n    wait(READ_RETRY_MS);\n  }\n  throw new Error('GitHub Release 只读接口重试状态异常');\n}\n\nfunction json(output, context) {\n  try {\n    return JSON.parse(output);\n  } catch {\n    throw new Error(`${context}返回了无效 JSON`);\n  }\n}\n\nfunction sourceMarker(input) {\n  return `<!-- CITIZENSDK_RELEASE_SOURCE_SHA:${input.sourceSHA} -->`;\n}\n\nfunction releaseBody(input) {\n  const notes = input.notes ?? readFileSync(input.notesFile, 'utf8');\n  return `${notes.trimEnd()}\\n\\n${sourceMarker(input)}\\n`;\n}\n\nexport function createClient() {\n  return {\n    async listReleases(repository) {\n      const releases = [];\n      for (let page = 1; page <= 100; page += 1) {\n        const output = gh(['api', `repos/${repository}/releases?per_page=100&page=${page}`], {\n          retryRead: true,\n        });\n        const values = json(output, 'GitHub Release 列表');\n        required(Array.isArray(values), 'GitHub Release 列表格式无效');\n        releases.push(...values);\n        if (values.length < 100) return releases;\n      }\n      throw new Error('GitHub Release 列表超过安全分页上限');\n    },\n    async getTag(repository, tag) {\n      const output = gh(['api', `repos/${repository}/git/ref/tags/${encodeURIComponent(tag)}`], {\n        notFound: true,\n        retryRead: true,\n      });\n      return output === null ? null : json(output, 'GitHub Tag');\n    },\n    async getTagObject(repository, objectSHA) {\n      return json(gh(['api', `repos/${repository}/git/tags/${objectSHA}`], { retryRead: true }), 'GitHub Tag 对象');\n    },\n    async createDraft(input) {\n      const args = [\n        'release', 'create', input.tag, '--repo', input.repository,\n        '--target', input.sourceSHA,\n        '--draft', '--title', input.title, '--notes', releaseBody(input),\n        ...input.assets.map((asset) => asset.path),\n      ];\n      // 中文注释：禁止预建或复用旧 Tag。GitHub 在同一个创建请求中通过 --target\n      // 将版本 Tag 原子锚定到本次成功 CI 的 sourceSHA；默认分支后续移动不影响该锚点。\n      gh(args);\n    },\n    async getRelease(repository, releaseId) {\n      const output = gh(['api', `repos/${repository}/releases/${releaseId}`], {\n        notFound: true,\n        retryRead: true,\n      });\n      return output === null ? null : json(output, 'GitHub Release');\n    },\n    async getReleaseByTag(repository, tag) {\n      const output = gh(\n        ['api', `repos/${repository}/releases/tags/${encodeURIComponent(tag)}`],\n        { notFound: true, retryRead: true },\n      );\n      return output === null ? null : json(output, 'GitHub Tag Release');\n    },\n    async publish(repository, releaseId, latest) {\n      const payload = JSON.stringify({ draft: false, make_latest: latest ? 'true' : 'false' });\n      gh(['api', '--method', 'PATCH', `repos/${repository}/releases/${releaseId}`, '--input', '-'], {\n        input: payload,\n      });\n    },\n    async deleteRelease(repository, releaseId) {\n      gh(['api', '--method', 'DELETE', `repos/${repository}/releases/${releaseId}`]);\n    },\n    async deleteTag(repository, tag) {\n      gh(['api', '--method', 'DELETE', `repos/${repository}/git/refs/tags/${encodeURIComponent(tag)}`]);\n    },\n    async wait() {\n      await new Promise((resolve) => setTimeout(resolve, 1_000));\n    },\n  };\n}\n\nfunction verifyAssets(release, assets) {\n  required(Array.isArray(release.assets), 'GitHub Release 资产格式无效');\n  required(release.assets.length === assets.length, 'GitHub Release 资产数量不符');\n  const actual = new Map();\n  for (const asset of release.assets) {\n    required(typeof asset?.name === 'string' && !actual.has(asset.name), 'GitHub Release 资产名称重复或无效');\n    actual.set(asset.name, asset);\n  }\n  for (const expected of assets) {\n    const asset = actual.get(expected.name);\n    required(asset, `GitHub Release 缺少资产：${expected.name}`);\n    required(asset.state === 'uploaded', `GitHub Release 资产未完成上传：${expected.name}`);\n    required(asset.size === expected.size, `GitHub Release 资产大小不符：${expected.name}`);\n  }\n}\n\nfunction verifyReleaseOwnership(release, input, draft) {\n  required(Number.isSafeInteger(release?.id) && release.id > 0, 'GitHub Release id 无效');\n  required(release.tag_name === input.tag, 'GitHub 版本 Tag 不符');\n  required(release.name === input.title, 'GitHub Release 标题不符');\n  required(release.draft === draft, draft ? 'GitHub Release 不是草稿' : 'GitHub Release 尚未固化');\n  required(typeof release.body === 'string' && release.body.includes(sourceMarker(input)),\n    'GitHub Release 未绑定本次成功 CI 源提交');\n}\n\nfunction verifyRelease(release, input, draft) {\n  verifyReleaseOwnership(release, input, draft);\n  verifyAssets(release, input.assets);\n}\n\n// 中文注释：草稿没有稳定的最终 Tag 查询入口，只能从含草稿的 Release 列表取得唯一数字 id。\nasync function findDraft(client, input) {\n  for (let attempt = 0; attempt < 5; attempt += 1) {\n    const matches = (await client.listReleases(input.repository))\n      .filter((value) => value?.tag_name === input.tag\n        && value?.name === input.title && value?.draft === true);\n    required(matches.length <= 1, `发现多个同名 GitHub Release：${input.tag}`);\n    if (matches.length === 1) return matches[0];\n    await client.wait();\n  }\n  return null;\n}\n\n// 中文注释：GitHub 的按 Tag Release 查询不可靠地覆盖草稿，因此每次删除版本 Tag 前，\n// 都必须重新分页枚举包含草稿的 Release 列表；任何同 Tag Release 都使删除失败关闭。\nasync function verifyTagDeletionOwnership(client, input, label) {\n  const attached = (await client.listReleases(input.repository))\n    .filter((value) => value?.tag_name === input.tag);\n  required(attached.length === 0, `${label} 已附着 GitHub Release，禁止删除`);\n  required(await versionTagCommit(client, input) === input.sourceSHA,\n    `${label} 未锚定本次成功 CI 源提交，禁止删除`);\n}\n\nasync function versionTagCommit(client, input) {\n  const reference = await client.getTag(input.repository, input.tag);\n  verifyTagReference(reference, input, '正式版本 Tag');\n  if (reference.object.type === 'commit') return reference.object.sha;\n  const object = await client.getTagObject(input.repository, reference.object.sha);\n  required(object?.tag === input.tag && object?.object?.type === 'commit'\n    && SHA_PATTERN.test(String(object.object.sha || '')), '正式版本 Tag 对象无效');\n  return object.object.sha;\n}\n\nfunction verifyTagReference(reference, input, label) {\n  required(reference?.ref === `refs/tags/${input.tag}`\n    && SHA_PATTERN.test(String(reference?.object?.sha || '')),\n  `${label}不存在或无效`);\n  required(reference.object.type === 'commit' || reference.object.type === 'tag',\n    `${label}类型无效`);\n}\n\nfunction errorMessage(error) {\n  return error instanceof Error ? error.message : String(error);\n}\n\nexport async function release(input, client = createClient()) {\n  let releaseId = null;\n  let transactionStarted = false;\n  let publishAttempted = false;\n  let formalObserved = false;\n  const existing = (await client.listReleases(input.repository))\n    .filter((value) => value?.tag_name === input.tag);\n  const published = existing.filter((value) => value?.draft === false);\n  required(published.length === 0, `正式 Release 已存在，禁止覆盖：${input.tag}`);\n  const drafts = existing.filter((value) => value?.draft === true);\n  required(drafts.length <= 1, `发现多个同 Tag 草稿 Release：${input.tag}`);\n\n  // 中文注释：同版本失败重试只清理由本动作管理的精确 Tag。草稿必须携带本次 sourceSHA\n  // 隐藏标记；孤立 Tag 没有正式 Release，属于上次事务中断残留，统一删除后重新原子创建。\n  if (drafts.length === 1) {\n    verifyReleaseOwnership(drafts[0], input, true);\n    await client.deleteRelease(input.repository, drafts[0].id);\n  }\n  const staleTag = await client.getTag(input.repository, input.tag);\n  if (staleTag) {\n    // 中文注释：孤立同名 Tag 可能来自人工操作或另一事务。删除紧前必须重新确认\n    // 没有正式或草稿 Release 附着，并把轻量或注解 Tag 最终解析到准确 sourceSHA。\n    await verifyTagDeletionOwnership(client, input, '同名孤立版本 Tag');\n    try {\n      await client.deleteTag(input.repository, input.tag);\n    } catch (deleteError) {\n      // 删除请求可能已在服务端成功后丢失响应；getTag 只有准确 HTTP 404 才返回 null。\n      let remaining;\n      try {\n        remaining = await client.getTag(input.repository, input.tag);\n      } catch (checkError) {\n        throw new Error(`孤立 Tag 删除失败：${errorMessage(deleteError)}；复核失败：${errorMessage(checkError)}`);\n      }\n      required(remaining === null,\n        `孤立 Tag 删除状态未确认：${errorMessage(deleteError)}`);\n    }\n    required(await client.getTag(input.repository, input.tag) === null,\n      '孤立 Tag 删除后仍然存在');\n  }\n\n  try {\n    transactionStarted = true;\n    // 中文注释：12 个产品、端 Release 动作都从这里执行同一个原子创建动作；--target sourceSHA\n    // 让 GitHub 原子生成并精确锚定版本 Tag，隐藏标记、Release 说明、manifest 与签名保留来源证据。\n    await client.createDraft(input);\n    let draft = await findDraft(client, input);\n    required(draft, `无法取得新建草稿 Release：${input.tag}`);\n    releaseId = draft.id;\n    draft = await client.getRelease(input.repository, releaseId);\n    verifyRelease(draft, input, true);\n    // 中文注释：必须在 PATCH 调用前记录发布尝试；调用可能已在 GitHub 成功后才报错。\n    publishAttempted = true;\n    await client.publish(input.repository, releaseId, input.latest);\n\n    const result = await client.getRelease(input.repository, releaseId);\n    if (result?.draft === false) formalObserved = true;\n    verifyRelease(result, input, false);\n    const byTag = await client.getReleaseByTag(input.repository, input.tag);\n    if (byTag?.draft === false) formalObserved = true;\n    required(byTag?.id === releaseId, '版本 Tag 未关联本次 GitHub Release');\n    verifyRelease(byTag, input, false);\n    required(await versionTagCommit(client, input) === input.sourceSHA,\n      '正式版本 Tag 未锚定本次成功 CI 源提交');\n    console.log(`正式 Release 与唯一版本 Tag 已固化：${input.tag}`);\n    return result;\n  } catch (error) {\n    // 中文注释：恢复阶段先完成全部只读核对。403、503、网络错误、无效 JSON、相互冲突的\n    // 读取结果都属于未知态；一旦任一路径观察到正式 Release，该事实不可逆且禁止任何删除。\n    let rollbackRelease = null;\n    let rollbackTag = null;\n    let recoveryFailure = null;\n    try {\n      let currentRelease = null;\n      if (releaseId !== null) {\n        currentRelease = await client.getRelease(input.repository, releaseId);\n      } else {\n        const discoveredDraft = await findDraft(client, input);\n        if (discoveredDraft !== null) {\n          verifyReleaseOwnership(discoveredDraft, input, true);\n          currentRelease = await client.getRelease(input.repository, discoveredDraft.id);\n          required(currentRelease !== null, '恢复核对时草稿按 id 消失');\n          releaseId = discoveredDraft.id;\n        }\n      }\n      if (currentRelease?.draft === false) formalObserved = true;\n\n      const byTag = await client.getReleaseByTag(input.repository, input.tag);\n      if (byTag?.draft === false) formalObserved = true;\n      const formalCandidates = [currentRelease, byTag]\n        .filter((value) => value?.draft === false);\n      if (formalCandidates.length > 0) {\n        for (const candidate of formalCandidates) {\n          if (releaseId !== null) {\n            required(candidate.id === releaseId, '恢复核对读到不同 id 的正式 Release');\n          }\n          verifyRelease(candidate, input, false);\n        }\n        required(byTag?.draft === false, '正式 Release 已形成但 Tag 查询尚未关联');\n        if (releaseId !== null) {\n          required(byTag.id === releaseId, '版本 Tag 未关联本次 GitHub Release');\n        }\n        required(await versionTagCommit(client, input) === input.sourceSHA,\n          '正式版本 Tag 未锚定本次成功 CI 源提交');\n        console.log(`正式 Release 已核对恢复：${input.tag}`);\n        return byTag;\n      }\n\n      required(!formalObserved, '已经观察到正式 Release，禁止回滚');\n      // getReleaseByTag 只有在 gh 从最终 HTTP 状态行读到准确 404 时才会返回 null。\n      required(byTag === null, 'Tag 查询返回了非正式的异常 Release');\n      if (currentRelease !== null) {\n        verifyReleaseOwnership(currentRelease, input, true);\n        if (releaseId !== null) {\n          required(currentRelease.id === releaseId, '恢复核对读到不同 id 的草稿 Release');\n        }\n        rollbackRelease = currentRelease;\n      }\n      const tag = await client.getTag(input.repository, input.tag);\n      if (tag !== null) verifyTagReference(tag, input, '待回滚 Tag');\n      rollbackTag = tag;\n    } catch (candidateError) {\n      recoveryFailure = candidateError;\n    }\n\n    if (recoveryFailure !== null || formalObserved) {\n      const phase = publishAttempted ? 'PATCH 后' : '发布前';\n      const detail = recoveryFailure === null\n        ? '已经观察到正式 Release'\n        : errorMessage(recoveryFailure);\n      throw new Error(`${errorMessage(error)}；${phase}恢复核对失败，远端状态已保留：${detail}`);\n    }\n\n    const cleanupErrors = [];\n    let releaseRemovalConfirmed = rollbackRelease === null;\n    if (transactionStarted) {\n      if (rollbackRelease !== null) {\n        try {\n          await client.deleteRelease(input.repository, rollbackRelease.id);\n          releaseRemovalConfirmed = true;\n        } catch (cleanupError) {\n          // 删除调用同样可能服务端成功而本机响应中断；只有按 id 精确 404 才确认已删除。\n          try {\n            const remaining = await client.getRelease(input.repository, rollbackRelease.id);\n            if (remaining === null) {\n              releaseRemovalConfirmed = true;\n            } else {\n              if (remaining.draft === false) formalObserved = true;\n              cleanupErrors.push(`草稿回滚状态未确认：${errorMessage(cleanupError)}`);\n            }\n          } catch (checkError) {\n            cleanupErrors.push(\n              `草稿回滚失败：${errorMessage(cleanupError)}；复核失败：${errorMessage(checkError)}`,\n            );\n          }\n        }\n      }\n\n      if (releaseRemovalConfirmed && !formalObserved && rollbackTag !== null) {\n        let tagDeletionVerified = false;\n        try {\n          await verifyTagDeletionOwnership(client, input, '待回滚版本 Tag');\n          tagDeletionVerified = true;\n        } catch (verificationError) {\n          cleanupErrors.push(\n            `Tag 回滚前归属核验失败：${errorMessage(verificationError)}`,\n          );\n        }\n        if (tagDeletionVerified) {\n          try {\n            await client.deleteTag(input.repository, input.tag);\n          } catch (cleanupError) {\n            try {\n              const remaining = await client.getTag(input.repository, input.tag);\n              if (remaining !== null) {\n                cleanupErrors.push(`Tag 回滚状态未确认：${errorMessage(cleanupError)}`);\n              }\n            } catch (checkError) {\n              cleanupErrors.push(\n                `Tag 回滚失败：${errorMessage(cleanupError)}；复核失败：${errorMessage(checkError)}`,\n              );\n            }\n          }\n        }\n      } else if (!releaseRemovalConfirmed && rollbackTag !== null) {\n        cleanupErrors.push('草稿删除未确认，已保留 Tag');\n      }\n    }\n    const suffix = cleanupErrors.length > 0 ? `；${cleanupErrors.join('；')}` : '';\n    throw new Error(`${errorMessage(error)}${suffix}`);\n  }\n}\n\nexport function parseArgs(argv, environment = process.env) {\n  const values = new Map();\n  const assetIndex = argv.indexOf('--assets');\n  required(assetIndex >= 0 && assetIndex < argv.length - 1, '缺少 --assets');\n  const assetPaths = argv.slice(assetIndex + 1);\n  const optionArgs = argv.slice(0, assetIndex);\n  required(optionArgs.length % 2 === 0, 'Release 参数必须成对提供');\n  for (let index = 0; index < optionArgs.length; index += 2) {\n    const key = optionArgs[index];\n    required(/^--[a-z-]+$/.test(key) && !values.has(key), `Release 参数无效或重复：${key}`);\n    values.set(key, optionArgs[index + 1]);\n  }\n\n  const repository = environment.GITHUB_REPOSITORY;\n  const tag = values.get('--tag');\n  const sourceSHA = values.get('--source-sha');\n  const title = values.get('--title');\n  const notes = values.get('--notes');\n  const notesFile = values.get('--notes-file');\n  const latestValue = values.get('--latest');\n  required(REPOSITORY_PATTERN.test(repository || ''), 'GITHUB_REPOSITORY 无效');\n  required(TAG_PATTERN.test(tag || ''), '版本 Tag 无效');\n  required(SHA_PATTERN.test(sourceSHA || ''), 'Release 源提交无效');\n  required(typeof title === 'string' && title.trim() === title && title.length > 0, 'Release 标题无效');\n  required(Boolean(notes) !== Boolean(notesFile), '必须且只能提供 --notes 或 --notes-file');\n  required(latestValue === 'true' || latestValue === 'false', '--latest 只允许 true 或 false');\n\n  const assets = assetPaths.map((path) => {\n    const value = lstatSync(path);\n    required(value.isFile() && value.size > 0, `Release 资产不是非空普通文件：${path}`);\n    return { path, name: basename(path), size: value.size };\n  });\n  required(new Set(assets.map((asset) => asset.name)).size === assets.length, 'Release 资产文件名重复');\n  return {\n    repository,\n    tag,\n    sourceSHA,\n    title,\n    notes,\n    notesFile,\n    latest: latestValue === 'true',\n    assets,\n  };\n}\n\nif (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {\n  try {\n    await release(parseArgs(process.argv.slice(2)));\n  } catch (error) {\n    console.error(error.message);\n    process.exitCode = 1;\n  }\n}\n","version-tag":"#!/usr/bin/env node\n\nimport { execFileSync } from 'node:child_process';\nimport { readFileSync } from 'node:fs';\nimport { pathToFileURL } from 'node:url';\n\nconst semanticVersionPattern = /^(0|[1-9]\\d*)\\.(0|[1-9]\\d?)\\.(0|[1-9]\\d?)$/;\nconst tagPrefixPattern = /^[a-z0-9][a-z0-9-]*-v$/;\nconst sourceSHAPattern = /^[0-9a-f]{40}$/;\n\nexport function parseSemanticVersion(value) {\n  const match = semanticVersionPattern.exec(String(value));\n  if (!match) throw new Error(`软件版本必须形如 a.b.c 且 b、c 不超过 99：${value}`);\n  return match.slice(1).map(Number);\n}\n\nexport function compareSemanticVersions(left, right) {\n  const a = parseSemanticVersion(left);\n  const b = parseSemanticVersion(right);\n  for (let index = 0; index < 3; index += 1) {\n    if (a[index] !== b[index]) return a[index] - b[index];\n  }\n  return 0;\n}\n\nexport function nextSemanticVersion(value) {\n  let [major, minor, patch] = parseSemanticVersion(value);\n  patch += 1;\n  if (patch > 99) {\n    patch = 0;\n    minor += 1;\n  }\n  if (minor > 99) {\n    minor = 0;\n    major += 1;\n  }\n  return `${major}.${minor}.${patch}`;\n}\n\nexport function expectedSemanticCandidate(seed, successfulVersions) {\n  parseSemanticVersion(seed);\n  const normalized = [...new Set(successfulVersions.map((value) => {\n    parseSemanticVersion(value);\n    return value;\n  }))].sort(compareSemanticVersions);\n  return normalized.length === 0 ? seed : nextSemanticVersion(normalized.at(-1));\n}\n\nfunction parseArguments(argv) {\n  const [command, ...rest] = argv;\n  if (!command) throw new Error('缺少版本命令');\n  const values = {};\n  for (let index = 0; index < rest.length; index += 2) {\n    const key = rest[index];\n    const value = rest[index + 1];\n    if (!key?.startsWith('--') || value === undefined) throw new Error(`参数格式无效：${key ?? ''}`);\n    const name = key.slice(2);\n    if (Object.hasOwn(values, name)) throw new Error(`参数重复：${key}`);\n    values[name] = value;\n  }\n  return { command, values };\n}\n\nfunction requireExactKeys(values, required, optional = []) {\n  const allowed = new Set([...required, ...optional]);\n  for (const key of Object.keys(values)) {\n    if (!allowed.has(key)) throw new Error(`不支持的参数：--${key}`);\n  }\n  for (const key of required) {\n    if (!Object.hasOwn(values, key) || values[key] === '') throw new Error(`缺少参数：--${key}`);\n  }\n}\n\nfunction ghJSON(path) {\n  const output = execFileSync('gh', ['api', path], {\n    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],\n  });\n  try {\n    return JSON.parse(output);\n  } catch {\n    throw new Error(`GitHub API 返回了无效 JSON：${path}`);\n  }\n}\n\nfunction readSeed(kind, path) {\n  const text = readFileSync(path, 'utf8');\n  if (kind === 'json') {\n    const value = JSON.parse(text)?.version;\n    parseSemanticVersion(value);\n    return value;\n  }\n  if (kind === 'pubspec') {\n    const matches = [...text.matchAll(/^version:\\s*([^+\\s]+)(?:\\+\\d+)?\\s*$/gm)];\n    if (matches.length !== 1) throw new Error(`pubspec 软件版本真源不唯一：${path}`);\n    parseSemanticVersion(matches[0][1]);\n    return matches[0][1];\n  }\n  throw new Error(`不支持的版本真源类型：${kind}`);\n}\n\nfunction publishedSemanticVersions(prefix) {\n  if (!tagPrefixPattern.test(prefix)) throw new Error('Tag 前缀无效');\n  const escaped = prefix.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&');\n  const pattern = new RegExp(`^${escaped}(${semanticVersionPattern.source.slice(1, -1)})$`);\n  const versions = [];\n  for (let page = 1; page <= 100; page += 1) {\n    const releases = ghJSON(`repos/{owner}/{repo}/releases?per_page=100&page=${page}`);\n    if (!Array.isArray(releases)) throw new Error('GitHub Release 列表格式无效');\n    for (const release of releases) {\n      if (release?.draft === true || release?.prerelease === true) continue;\n      const tag = String(release?.tag_name || '');\n      if (!tag.startsWith(prefix)) continue;\n      const match = pattern.exec(tag);\n      if (!match) throw new Error(`同前缀正式 Release Tag 不符合统一版本契约：${tag}`);\n      parseSemanticVersion(match[1]);\n      versions.push(match[1]);\n    }\n    if (releases.length < 100) return versions;\n  }\n  throw new Error('GitHub Release 列表超过安全分页上限');\n}\n\nfunction validateIdentity(values) {\n  if (!/^[a-z][a-z0-9-]*$/.test(values['product-id'])) throw new Error('product_id 无效');\n  if (!/^[a-z][a-z0-9-]*$/.test(values.target)) throw new Error('target 无效');\n  // 规范 pipeline 与 GitHub workflow 文件名是两个独立身份，不能互相代替。\n  if (values['product-id'] !== 'citizensdk' || values.target !== 'sdk'\n    || values.pipeline !== 'citizensdk.sdk.ci') throw new Error('CitizenSDK pipeline 身份无效');\n  if (!sourceSHAPattern.test(values['source-sha'])) throw new Error('source_sha 无效');\n  if (!/^[1-9]\\d*$/.test(values['ci-run-id'])) throw new Error('ci_run_id 无效');\n}\n\nfunction verifySuccessfulCIRun(values) {\n  validateIdentity(values);\n  const expectedTitle = '公民SDK · SDK · CI';\n  const run = ghJSON(`repos/{owner}/{repo}/actions/runs/${values['ci-run-id']}`);\n  if (run.status !== 'completed' || run.conclusion !== 'success'\n    || run.event !== 'workflow_dispatch' || run.head_branch !== 'main'\n    || run.head_sha !== values['source-sha']\n    || String(run.display_title || '') !== expectedTitle\n    || run.path !== '.github/workflows/citizensdk-sdk-ci.yml') {\n    throw new Error('Release 来源不是同产品、同端、同 pipeline 的成功 CI');\n  }\n  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();\n  if (head !== values['source-sha']) throw new Error(`checkout 与 source_sha 不一致：${head}`);\n}\n\nfunction printNextSemanticRelease(values) {\n  requireExactKeys(values, ['prefix', 'seed']);\n  const candidate = expectedSemanticCandidate(\n    values.seed,\n    publishedSemanticVersions(values.prefix),\n  );\n  process.stdout.write(`${candidate}\\n`);\n}\n\nfunction verifyReleaseSource(values) {\n  requireExactKeys(values, [\n    'version-tag', 'source-sha', 'ci-run-id', 'prefix', 'product-id', 'target', 'pipeline', 'software-version',\n  ]);\n  // 本入口只属于 CitizenSDK；不能借其它产品的 Tag 前缀或 Runtime 参数通过。\n  if (values.prefix !== 'citizensdk-sdk-v'\n    || !values['version-tag'].startsWith(values.prefix)) {\n    throw new Error('Release 版本 Tag 身份无效');\n  }\n  const suffix = values['version-tag'].slice(values.prefix.length);\n  parseSemanticVersion(suffix);\n  if (values['software-version'] !== suffix) throw new Error('CitizenSDK Tag 与正式软件版本不一致');\n  verifySuccessfulCIRun(values);\n  const seed = readSeed('pubspec', 'pubspec.yaml');\n  if (seed !== suffix) throw new Error('CitizenSDK 正式版本与冻结源码不一致');\n  const expected = expectedSemanticCandidate(seed, publishedSemanticVersions(values.prefix));\n  if (suffix !== expected) {\n    throw new Error(`Release 版本不是正式 Release 真源的下一版本：期望 ${expected}，收到 ${suffix}`);\n  }\n  process.stdout.write(`Release 已锁定成功 CI：${values['ci-run-id']} · ${values['source-sha']}\\n`);\n}\n\nexport function main(argv) {\n  const { command, values } = parseArguments(argv);\n  if (command === 'next-semantic-release') return printNextSemanticRelease(values);\n  if (command === 'verify-release-source') return verifyReleaseSource(values);\n  throw new Error(`不支持的版本命令：${command}`);\n}\n\nif (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {\n  try {\n    main(process.argv.slice(2));\n  } catch (error) {\n    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\\n`);\n    process.exitCode = 1;\n  }\n}\n"});

// 两个动作都只负责调用；SDK 候选算法只存在于冻结 checkout 中，不物化第二份源码。
function checkedPath(value, directory, allowMissing = false) {
  if (typeof value !== 'string' || !isAbsolute(value)
      || value.split(/[\\/]/u).some((part) => part === '.' || part === '..')) {
    throw new Error('CitizenSDK 路径必须是无穿越的绝对路径');
  }
  const absolute = resolve(value);
  let current = parse(absolute).root;
  const parts = relative(current, absolute).split(sep).filter(Boolean);
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index]);
    let stat;
    try { stat = lstatSync(current); }
    catch (error) {
      if (allowMissing && error.code === 'ENOENT') {
        return resolve(realpathSync(join(current, '..')), ...parts.slice(index));
      }
      throw error;
    }
    if (stat.isSymbolicLink() || (index < parts.length - 1 || directory
      ? !stat.isDirectory() : !stat.isFile())) {
      throw new Error('CitizenSDK 路径含链接或非预期节点');
    }
  }
  if (parts.length === 0) throw new Error('CitizenSDK 不接受文件系统根目录');
  return realpathSync(absolute);
}

export function sdkCommand(argumentsList, environment = process.env, cwd = process.cwd()) {
  const repositoryRoot = checkedPath(environment.GITHUB_WORKSPACE || cwd, true);
  const sourceRoot = checkedPath(repositoryRoot, true);
  const script = checkedPath(join(sourceRoot, 'scripts', 'release.mjs'), false);
  const values = new Map();
  if (argumentsList.length === 0 || argumentsList.length % 2 !== 0) {
    throw new Error('CitizenSDK 参数必须是完整键值对');
  }
  for (let index = 0; index < argumentsList.length; index += 2) {
    const key = argumentsList[index], value = argumentsList[index + 1];
    if (typeof key !== 'string' || !/^--[a-z-]+$/u.test(key)
        || typeof value !== 'string' || !value || value.startsWith('--')
        || values.has(key)) throw new Error('CitizenSDK 参数为空、重复或格式无效');
    values.set(key, value);
  }
  // Hosted 仍由同一源码发布器执行；这里只验证准确参数和来源，不物化另一份打包器。
  const hosted = values.has('--hosted'), verifyHosted = values.has('--verify-hosted');
  const verify = values.has('--verify');
  const required = hosted ? ['--hosted', '--archive', '--output', '--dart', '--flutter', '--pub-cache']
    : verifyHosted ? ['--verify-hosted', '--archive', '--hosted-archive', '--output']
    : verify ? ['--verify', '--archive']
    : ['--source', '--native', '--output', '--archive', '--git-sha', '--software-version'];
  const allowed = new Set([...required, ...(verify || hosted || verifyHosted ? ['--expected-git-sha'] : [])]);
  if (required.some((key) => !values.has(key))
      || [...values.keys()].some((key) => !allowed.has(key))) {
    throw new Error('CitizenSDK 动作参数不在生成/验真/Hosted 闭集');
  }
  if (hosted || verifyHosted) {
    for (const key of required) {
      const input = checkedPath(values.get(key), ['--hosted', '--verify-hosted', '--flutter', '--pub-cache', '--output'].includes(key), key === '--output');
      // 所有 Hosted 输入和输出均不得等于、包含或位于 checkout 的 SDK 源树。
      for (const [parent, child] of [[sourceRoot, input], [input, sourceRoot]]) {
        const path = relative(parent, child);
        if (path === '' || (!path.startsWith('..' + sep) && path !== '..' && !isAbsolute(path))) {
          throw new Error('CitizenSDK Hosted 路径与 checkout 源码交叠');
        }
      }
    }
  } else if (!verify) {
    const source = values.get('--source');
    if (source !== '.' && source.split(/[\\/]/u).some((part) => part === '.' || part === '..')
        || checkedPath(resolve(repositoryRoot, source), true) !== sourceRoot) {
      throw new Error('CitizenSDK --source 必须是当前 SDK checkout 根');
    }
  }
  const sha = values.get(verify || hosted || verifyHosted ? '--expected-git-sha' : '--git-sha');
  const frozen = environment.CITIZENSDK_SOURCE_SHA;
  if ((sha !== undefined && !/^[0-9a-f]{40}$/u.test(sha))
      || (frozen !== undefined && (!/^[0-9a-f]{40}$/u.test(frozen) || sha !== frozen))
      || (environment.GITHUB_ACTIONS === 'true' && !frozen)) {
    throw new Error('CitizenSDK Git SHA 必须对应当前冻结 checkout');
  }
  return { script, argumentsList: [...argumentsList], repositoryRoot };
}

export function runSdkCommand(command) {
  return new Promise((resolveResult, reject) => {
    const hosted = command.argumentsList.includes('--hosted');
    if (hosted && process.platform === 'win32') {
      reject(new Error('CitizenSDK Hosted 归档需要 POSIX 进程组监督'));
      return;
    }
    const environment = { ...process.env, CITIZENSDK_REPOSITORY_ROOT: command.repositoryRoot };
    // 不把 Node 预加载/搜索路径带入唯一源码脚本；不经过 shell 拼接参数。
    delete environment.NODE_OPTIONS;
    delete environment.NODE_PATH;
    const child = spawn(process.execPath, [command.script, ...command.argumentsList], {
      cwd: command.repositoryRoot, env: environment, stdio: hosted ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      shell: false, detached: process.platform !== 'win32',
    });
    let terminalCode = null;
    let escalation;
    let settled = false;
    let deadline;
    const cleanup = () => {
      clearTimeout(deadline);
      clearTimeout(escalation);
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', stop);
    };
    const finish = (error, code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (hosted && error) {
        // 监督失败不删目录、不猜测内部 Dart PID；允许保留现场后有界返回。
        error.preserveHostedOutput = true;
        child.stdout.destroy(); child.stderr.destroy(); child.unref();
      }
      if (error) reject(error);
      else resolveResult(code);
    };
    const signal = (name) => {
      if (!child.pid) return;
      if (process.platform === 'win32') child.kill(name);
      else {
        try { process.kill(-child.pid, name); }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
    };
    const terminate = (name, code) => {
      if (settled || terminalCode !== null) return;
      terminalCode = code;
      if (hosted) {
        // 只通知发布器；由它停止独立 Dart/Pub 组并确认退出，不能五秒后强杀发布器。
        try { child.kill('SIGTERM'); }
        catch (error) { finish(error); return; }
        escalation = setTimeout(() => finish(new Error('CitizenSDK Hosted 监督器未确认退出，保留其工作目录')), 30000);
        return;
      }
      // OS 拒绝终止必须作为监督失败返回，不能从信号/定时器回调抛出未捕获异常。
      try { signal(name); }
      catch (error) { finish(error); return; }
      if (name !== 'SIGKILL') escalation = setTimeout(() => {
        try { signal('SIGKILL'); } catch (error) { finish(error); }
      }, 5000);
    };
    const interrupt = () => terminate('SIGTERM', 130);
    const stop = () => terminate('SIGTERM', 143);
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', stop);
    deadline = setTimeout(() => {
      process.stderr.write('CitizenSDK 源码动作超时\n');
      terminate('SIGKILL', 124);
    }, 10 * 60 * 1000);
    if (hosted) {
      child.stdout.on('data', (chunk) => process.stdout.write(chunk));
      child.stderr.on('data', (chunk) => process.stderr.write(chunk));
      child.stdout.on('error', () => terminate('SIGTERM', 1));
      child.stderr.on('error', () => terminate('SIGTERM', 1));
    }
    child.once('error', (error) => finish(error));
    child.once('close', async (code, childSignal) => {
      if (settled) return;
      clearTimeout(deadline);
      clearTimeout(escalation);
      try {
        // Hosted 的内部进程组只由发布器负责；本层只能核验自己的组，不替它宣称收尾。
        if (process.platform !== 'win32' && child.pid) {
          if (!hosted) signal('SIGKILL');
          const until = Date.now() + 5000;
          for (;;) {
            try { process.kill(-child.pid, 0); }
            catch (error) {
              if (error.code === 'ESRCH') break;
              throw error;
            }
            if (Date.now() >= until) throw new Error('CitizenSDK 子进程组未确认退出');
            await new Promise((resume) => setTimeout(resume, 25));
          }
        }
        finish(null, terminalCode ?? code
          ?? ({ SIGINT: 130, SIGTERM: 143, SIGKILL: 137 }[childSignal] ?? 1));
      } catch (error) { finish(error); }
    });
  });
}

async function main() {
  const [command, ...argumentsList] = process.argv.slice(2);
  if (command === 'citizensdk-release') {
    process.exitCode = await runSdkCommand(sdkCommand(argumentsList));
    return;
  }
  if (!command || !Object.hasOwn(implementations, command)) {
    console.error('未登记动作子命令；允许值：citizensdk-release、' + Object.keys(implementations).join('、'));
    process.exitCode = 2;
    return;
  }
  // 原有版本/正式动作保持原实现，依赖包装只定位受控真实文件；不在此重建另一套合同。
  const repositoryRoot = process.env.GITHUB_WORKSPACE
    ? realpathSync(process.env.GITHUB_WORKSPACE) : process.cwd();
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'gmb-action-'));
  const implementationPath = join(temporaryDirectory, 'implementation.mjs');
  try {
    writeFileSync(implementationPath, implementations[command], { mode: 0o700 });
    const result = spawnSync(process.execPath, [realpathSync(implementationPath), ...argumentsList], {
      cwd: repositoryRoot,
      env: { ...process.env, CITIZENSDK_REPOSITORY_ROOT: repositoryRoot },
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); }
  catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
