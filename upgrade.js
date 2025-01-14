var _ = require('underscore');
var async = require('async');
var chalk = require('chalk');
var fs = require('fs-extra');
var prompt = require('prompt');
var optimist = require('optimist');
var path = require('path');
var semver = require('semver');
var migrateMongoose = require('migrate-mongoose');

var configuration = require('./lib/configuration');
var logger = require('./lib/logger');
var origin = require('./lib/application');
var OutputConstants = require('./lib/outputmanager').Constants;
var installHelpers = require('./lib/installHelpers');

var IS_INTERACTIVE = process.argv.length === 2;

var DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 6.1; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/41.0.2272.118 Safari/537.36';
var app = origin();

/**
* Start of execution
*/
start();

function start() {
  installHelpers.checkPrimaryDependencies(function(error) {
    if(error) {
      return installHelpers.exit(1, error.message);
    }
    // don't show any logger messages in the console
    logger.level('console','error');

    prompt.override = optimist.argv;

    // start the server first
    app.run({ skipVersionCheck: true, skipStartLog: true });
    app.on('serverStarted', function() {
      installHelpers.checkSecondaryDependencies(function(error) {
        ensureRepoValues();
        getUserInput();
      });
    });
  });
}

function ensureRepoValues() {
  if(configuration.getConfig('frameworkRepository') === '') {
    configuration.setConfig('frameworkRepository', installHelpers.DEFAULT_FRAMEWORK_REPO);
  }
  if(configuration.getConfig('authoringToolRepository') === '') {
    configuration.setConfig('authoringToolRepository', installHelpers.DEFAULT_SERVER_REPO);
  }
}

function getUserInput() {
  // properties for the prompts
  var confirmProperties = {
    name: 'continue',
    description: 'Continue? Y/n',
    type: 'string',
    default: 'Y',
    before: installHelpers.inputHelpers.toBoolean
  };
  var upgradeProperties = {
    properties: {
      updateAutomatically: {
        description: 'Update automatically? Y/n',
        type: 'string',
        default: 'Y',
        before: installHelpers.inputHelpers.toBoolean
      }
    }
  };
  var tagProperties = {
    properties: {
      authoringToolGitTag: {
        type: 'string',
        description: 'Specific git revision to be used for the authoring tool. Accepts any valid revision type (e.g. branch/tag/commit)',
        default: ''
      },
      frameworkGitTag: {
        type: 'string',
        description: 'Specific git revision to be used for the framework. Accepts any valid revision type (e.g. branch/tag/commit)',
        default: ''
      }
    }
  };
  if (IS_INTERACTIVE) {
    console.log(`\nThis script will update the ${app.polyglot.t('app.productname')} and/or Adapt Framework. Would you like to continue?`);
  }
  installHelpers.getInput(confirmProperties, function(result) {
    if(!installHelpers.inputHelpers.toBoolean(result.continue)) {
      return installHelpers.exit();
    }
    installHelpers.getInput(upgradeProperties, function(result) {
      console.log('');
      if(installHelpers.inputHelpers.toBoolean(result.updateAutomatically)) {
        return checkForUpdates(function(error, updateData) {
          if(error) {
            return installHelpers.exit(1, error);
          }
          doUpdate(updateData);
        });
      }
      // no automatic update, so get the intended versions
      installHelpers.getInput(tagProperties, function(result) {
        console.log('');
        if(!result.authoringToolGitTag && !result.frameworkGitTag) {
          return installHelpers.exit(1, 'Cannot update sofware if no revisions are specified.');
        }
        doUpdate({
          adapt_authoring: result.authoringToolGitTag,
          adapt_framework: result.frameworkGitTag
        });
      });
    });
  });
}

function checkForUpdates(callback) {
  var isCustomFramework = configuration.getConfig('frameworkRepository') !== installHelpers.DEFAULT_FRAMEWORK_REPO;
  var isCustomServer = configuration.getConfig('authoringToolRepository') !== installHelpers.DEFAULT_SERVER_REPO;
  if(isCustomFramework || isCustomServer) {
    return callback('Cannot perform an automatic upgrade when custom repositories are used.');
  }
  installHelpers.showSpinner('Checking for updates');
  installHelpers.getUpdateData(function(error, data) {
    installHelpers.hideSpinner();
    if(error) {
      return callback(error);
    }
    if(!data) {
      return installHelpers.exit(0, `Your software is already up-to-date, no need to upgrade.`);
    }
    console.log(chalk.underline('Software updates found.\n'));
    callback(null, data);
  });
}

function doUpdate(data) {
  async.series([
    function upgradeAuthoring(cb) {
      if (installHelpers.inputHelpers.isFalsyString(data.adapt_authoring)) {
        return cb();
      }
      installHelpers.updateAuthoring({
        repository: configuration.getConfig('authoringToolRepository'),
        revision: data.adapt_authoring,
        directory: configuration.serverRoot
      }, function(error) {
        if(error) {
          console.log(`Failed to update ${configuration.serverRoot} to '${data.adapt_authoring}'`);
          return cb(error);
        }
        console.log(`${app.polyglot.t('app.productname')} upgraded to ${data.adapt_authoring}`);
        cb();
      });
    },
    function upgradeFramework(cb) {
      if (installHelpers.inputHelpers.isFalsyString(data.adapt_framework)) {
        return cb();
      }
      var dir = path.join(configuration.tempDir, configuration.getConfig('masterTenantID'), OutputConstants.Folders.Framework);
      installHelpers.updateFramework({
        repository: configuration.getConfig('frameworkRepository'),
        revision: data.adapt_framework,
        directory: dir
      }, function(error) {
        if(error) {
          console.log(`Failed to upgrade ${dir.replace(configuration.serverRoot, '')} to ${data.adapt_framework}`);
          return cb(error);
        }
        console.log(`Adapt framework upgraded to ${data.adapt_framework}`);
        cb();
      });
    },
    function runMigrations(callback) {
      installHelpers.syncMigrations(function(err, migrations) {
        if(err) {
          return callback(err);
        }
        installHelpers.getMigrationConfig(function(err, config) {
          if(err){
            return callback(err);
          }
          var migrator = new migrateMongoose({
            migrationsPath: config.migrationsDir,
            dbConnectionUri: config.dbConnectionUri,
            autosync: true
          });
          migrator.list().then(function(migrations) {
            var migrationsDone = 0;
            async.eachSeries(migrations, function(migration, callback) {
              if(migration.state === 'up') {
                return callback();
              }
              console.log(`Running ${migration.name} migration`);
              migrationsDone++;
              migrator.run('up', migration.name).then(v => callback()).catch(callback);

            }, function(err, data) {
              if(err) {
                return callback(err);
              }
              if(migrationsDone > 0) {
                console.log(`${migrationsDone} migration${migrationsDone > 1 ? 's' : ''} ran successfully`);
              } else {
                console.log(`No migrations to run`);
              }
              callback();
            });
          }).catch(callback);
        });
      })
    }
  ], function(error) {
    if(error) {
      console.error('ERROR:', error);
      return installHelpers.exit(1, 'Upgrade was unsuccessful. Please check the console output.');
    }
    installHelpers.exit(0, `Your ${app.polyglot.t('app.productname')} was updated successfully.`);
  });
}
