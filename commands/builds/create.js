'use strict'

let cli = require('heroku-cli-util')
let fs = require('fs')
let uuid = require('node-uuid')
let os = require('os')
let path = require('path')
let exec = require('child_process').execSync
let nodeTar = require('../../lib/node_tar')

function compressSource (context, cwd, tempFile) {
  return new Promise(function (resolve, reject) {
    var tar = context.flags['tar'] || 'tar'
    let tarVersion = ''

    try {
      tarVersion = exec(tar + ' --version').toString()
    } catch (err) {
      if (err.toString().match(/not found/)) {
        // tar was not found on the system
      } else {
        throw err
      }
    }

    if (tarVersion.match(/GNU tar/)) {
      let includeVcsIgnore = context.flags['include-vcs-ignore']
      let command = tar + ' cz -C ' + cwd + ' --exclude .git --exclude .gitmodules .'

      if (!includeVcsIgnore) {
        command += ' --exclude-vcs-ignores'
      }

      exec(command + ' > ' + tempFile)
      resolve()
    } else {
      cli.warn('Couldn\'t detect GNU tar. Builds could fail due to decompression errors')
      cli.warn('See https://devcenter.heroku.com/articles/platform-api-deploying-slugs#create-slug-archive')
      cli.warn('Please install it, or specify the \'--tar\' option')
      cli.warn('Falling back to node\'s built-in compressor')
      nodeTar.call(cwd, tempFile).then(resolve, reject)
    }
  })
}

async function uploadCwdToSource (context, heroku, cwd) {
  let tempFilePath = path.join(os.tmpdir(), uuid.v4() + '.tar.gz')
  let source = await heroku.post('/sources')
  await compressSource(context, cwd, tempFilePath)
  await cli.got.put(source.source_blob.put_url, {
    body: fs.createReadStream(tempFilePath),
    headers: {
      'Content-Type': '',
      'Content-Length': fs.statSync(tempFilePath).size
    }
  })
  return source.source_blob.get_url
}

function create (context, heroku) {
  var sourceUrl = context.flags['source-url']
  var cwd = context.flags['cwd'] || process.cwd()

  var sourceUrlPromise = sourceUrl
    ? new Promise(function (resolve) { resolve(sourceUrl) })
    : new Promise(function (resolve, reject) { uploadCwdToSource(context, heroku, cwd).then(resolve, reject) })

  return new Promise(function (resolve, reject) {
    sourceUrlPromise.then(function (sourceGetUrl) {
      heroku.request({
        method: 'POST',
        path: `/apps/${context.app}/builds`,
        body: {
          source_blob: {
            url: sourceGetUrl,
            // TODO provide better default, eg. archive md5
            version: context.flags.version || ''
          }
        }
      }).then(function (build) {
        let stream = cli.got.stream(build.output_stream_url)
        stream.on('error', reject)
        stream.on('end', resolve)
        let piped = stream.pipe(process.stderr)
        piped.on('error', reject)
      }, reject)
    }, reject)
  })
}

module.exports = {
  topic: 'builds',
  command: 'create',
  needsAuth: true,
  needsApp: true,
  help: 'Create build from contents of current dir',
  description: 'create build',
  flags: [
    { name: 'source-url', description: 'source URL that points to the tarball of your application\'s source code', hasValue: true },
    { name: 'cwd', description: 'the local path to build. Defaults to pwd', hasValue: true },
    { name: 'tar', description: 'path to the executable GNU tar', hasValue: true },
    { name: 'version', description: 'description of your new build', hasValue: true },
    { name: 'include-vcs-ignore', description: 'include files ignores by VCS (.gitignore, ...) from the build' }
  ],
  run: cli.command(create)
}
