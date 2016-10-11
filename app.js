const request = require('request-promise'); // eslint-disable-line
const Bluebird = require('bluebird');
const _ = require('lodash');
const cwd = require('cwd');
const chalk = require('chalk');
const Slack = require('slack-node');
const moment = require('moment');

require('dotenv-safe').load({
  sample: cwd('.env.sample'),
  silent: true
});

const GATE_KEEPER_CONFIG = [
  {
    key: 'maintain',
    token: ' general maintainers',
    display: 'maintainers',
    requiredIfPresent: true
  },
  {
    key: 'platform',
    token: ' platform review',
    requiredIfPresent: true
  },
  {
    key: 'css',
    token: ' css review',
    signOffKey: 'sign-offs required'
  },
  {
    key: 'qa',
    token: ' quality assurance'
  }]
  .map(sk => {
    sk.signOffKey = sk.signOffKey || 'sign-off required';
    sk.pluralKey = sk.pluralKey || `${sk.key}ers`;
    sk.display = sk.display || sk.key;

    return sk;
  });

const team = process.env.GITHUB_ORG.trim();
const upstreamOwners = process.env.UPSTREAM_OWNERS.split(',').map(owner => owner.trim());
const EXCLUDE_MENTIONS = isTruthy(process.env.EXCLUDE_USER_MENTIONS);
const ONLY_WEEKDAYS = isTruthy(process.env.ONLY_WEEKDAYS);
const SLACK_EXCLUDE_SHARE_SUMMARY = isTruthy(process.env.SLACK_EXCLUDE_SHARE_SUMMARY);
const SLACK_CHANNEL_STALE = parseStaleChannels(process.env.SLACK_CHANNEL_STALE);
const DOW_TODAY = moment().weekday();
const DOW_START = 1; // Monday
const DOW_END = 5; // Friday

let organization;
let upstreamRepos;

const debugApp = getDebugName('config');

debugApp(JSON.stringify({
  env: {
    EXCLUDE_USER_MENTIONS: EXCLUDE_MENTIONS || '',
    GITHUB_API_BASE_URL: process.env.GITHUB_API_BASE_URL || '',
    GITHUB_ORG: process.env.GITHUB_ORG || '',
    GITHUB_TOKEN: process.env.GITHUB_TOKEN || '',
    ONLY_WEEKDAYS: ONLY_WEEKDAYS || '',
    SLACK_BOT_ICON_URL: process.env.SLACK_BOT_ICON_URL || '',
    SLACK_BOT_NAME: process.env.SLACK_BOT_NAME || '',
    SLACK_CHANNEL: process.env.SLACK_CHANNEL || '',
    SLACK_CHANNEL_STALE: SLACK_CHANNEL_STALE || '',
    SLACK_EXCLUDE_SHARE_SUMMARY: SLACK_EXCLUDE_SHARE_SUMMARY || '',
    SLACK_WEBHOOK_URL: process.env.SLACK_WEBHOOK_URL || '',
    UPSTREAM_OWNERS: process.env.UPSTREAM_OWNERS || ''
  }
}));

if (ONLY_WEEKDAYS && !(DOW_START <= DOW_TODAY && DOW_END >= DOW_TODAY)) {
  log('Today is not a weekday. Nothing to do.');

  return;
}

log(`Retrieving team info for ${team}...`, false);
request(getOpts(`/orgs/${team}`))
  .then(org => {
    // Get team members
    log('done');
    organization = _.pick(org, 'login');

    const debugTeamOrg = getDebugName('team');

    debugTeamOrg(JSON.stringify(org));

    log(`Retrieving ${organization.login} members...`, false);

    return request(getOpts(`/orgs/${organization.login}/public_members`));
  })
  .then(members => {
    // Get upstream repos
    organization.members = members.map(member => member.login);
    log(`done [${organization.members.join(', ')}]`);

    const debugMembers = getDebugName('team:members');

    debugMembers(JSON.stringify(members));

    const repoPromises = upstreamOwners.map(owner => request(getOpts(`/orgs/${owner}/repos?type=public`)));

    log(`Retrieving upstream repos [${upstreamOwners.join(', ')}]...`, false);

    return Bluebird.all(repoPromises);
  })
  .then(results => {
    // Dehydrate upstream repos' info
    const allRepos = results.reduce((arr, repos) => {
      const lightRepos = repos.map(mapToLightRepo);

      return arr.concat(lightRepos);
    }, []);

    const debugUpstreamRepos = getDebugName('repos:upstream');

    debugUpstreamRepos(JSON.stringify(results));

    log(`done [${allRepos.length}]`);

    return allRepos;
  })
  .then(allRepos => {
    // Get team repos
    upstreamRepos = allRepos;

    log(`Retreiving ${organization.login} repos...`, false);

    return request(getOpts(`/orgs/${organization.login}/repos?per_page=100`));
  })
  .then(teamRepos => {
    // Consolidate team repos to only those that have been forked from upstream owners we care about
    log(`done [${teamRepos.length}]`);

    const lightRepos = teamRepos.map(mapToLightRepo);
    const allRepos = upstreamRepos.concat(lightRepos);
    const grouped = _.groupBy(allRepos, 'name');

    const debugTeamRepos = getDebugName('repos:team');

    debugTeamRepos(JSON.stringify(teamRepos));

    // console.log(JSON.stringify(grouped, null, 2));
    const forkedRepoNames = Object
      .keys(grouped)
      .filter(key => grouped[key].length > 1)
      ;

    return forkedRepoNames.map(fork => _.find(upstreamRepos, {name: fork}));
  })
  .then(upstreamTeamRepos => {
    // Grab upstream and team open PRs

    const repoIssuePromises = upstreamTeamRepos.map(repo => request(getOpts(`/repos/${repo.owner}/${repo.name}/issues?&state=open`)));
    const teamRepoIssuePromises = upstreamTeamRepos.map(repo => request(getOpts(`/repos/${organization.login}/${repo.name}/issues?&state=open`)));

    log('Retrieving upstream pull requests...', false);

    return Bluebird
      .all(repoIssuePromises)
      .then(upstreamIssueResults => {
        const upstreamPullRequestsCount = upstreamIssueResults.reduce((cnt, issues) => cnt + issues.length, 0);

        log(`done [${upstreamPullRequestsCount}]`);

        const debugUpstreamPRs = getDebugName('pull-requests:upstream');

        debugUpstreamPRs(JSON.stringify(upstreamIssueResults));

        log(`Retrieving ${organization.login} pull requests...`, false);

        return Bluebird
          .all(teamRepoIssuePromises)
          .then(teamIssueResults => {
            const teamPullRequestsCount = teamIssueResults.reduce((cnt, issues) => cnt + issues.length, 0);

            log(`done [${teamPullRequestsCount}]`);

            const debugTeamPRs = getDebugName('pull-requests:team');

            debugTeamPRs(JSON.stringify(upstreamIssueResults));

            return [upstreamIssueResults, teamIssueResults];
          })
          ;
      })
      ;
  })
  .then(results => {
    // Merge PRs into a usable object
    log('Consolidating pull requests...', false); // eslint-disable-line
    const allPullRequests = reducePRs(results[0]);
    const teamPullRequests = reducePRs(results[1]);

    return {
      upstream: {
        prs: allPullRequests
      },
      team: {
        prs: teamPullRequests
      }
    };
  })
  .then(summary => {
    // Filter out non-team member PRs
    summary.upstream.prs = summary.upstream.prs.filter(pr => organization.members.indexOf(pr.author) > -1);

    log(`done [${summary.upstream.prs.length + summary.team.prs.length}]`);

    return Bluebird.resolve(summary);
  })
  .then(summary => {
    // Parse comments on each PR to determine Further Reviewers and if they have marked them as LGTM or not
    const upstreamPRCommentsPromises = summary.upstream.prs.map(pr => request(getOpts(`/repos/${pr.ownerRepo}/issues/${pr.number}/comments`)));
    const JENKINS_LOGIN = 'jenkins';
    const lgtmReg = /(LGTM|\:\+1\:|\:ship[\_]?it\:)/ig;

    return Bluebird
      .all(upstreamPRCommentsPromises)
      .then(results => {
        results.forEach(comments => {
          const jenkinsComment = _.find(comments, comment => comment.user.login === JENKINS_LOGIN);

          if (!jenkinsComment) {
            return;
          }

          const prUrl = convertIssueUrlToPrUrl(jenkinsComment.issue_url);

          const lgtmPeople = comments
            .filter(comment => !!(comment.body.match(lgtmReg) || []).length && comment.user.login !== JENKINS_LOGIN)
            .map(comment => comment.user.login.toLowerCase())
            ;

          summary.upstream.prs = summary.upstream.prs.map(pr => {
            if (pr.url === prUrl) {
              pr.signoffs = parseOutGateKeepers(jenkinsComment.body);
              pr.lgtm = lgtmPeople;
            }

            return pr;
          });
        });

        return summary;
      });
  })
  .then(summary => {
    const debugSummary = getDebugName('summary');

    debugSummary(JSON.stringify(summary));

    // Send summary to stdOut and post to Slack if configured
    const stdOutSummary = getStdOutSummary(summary);
    const slackSummary = slackify(summary);

    console.log(stdOutSummary); // eslint-disable-line

    if (!process.env.SLACK_WEBHOOK_URL) {
      console.log(chalk.gray('To post to a Slack, set the SLACK_WEBHOOK_URL environment variable appropriately.')); // eslint-disable-line

      return;
    }

    const slack = new Slack();

    slack.setWebhook(process.env.SLACK_WEBHOOK_URL);

    slack.webhook({
      channel: process.env.SLACK_CHANNEL,
      username: process.env.SLACK_BOT_NAME,
      'icon_emoji': process.env.SLACK_BOT_ICON_URL,
      text: slackSummary
    }, (err, response) => {
      if (err) {
        console.log(JSON.stringify(err, null, 2));  // eslint-disable-line
        return;
      }

      console.log(chalk.gray(`This was posted to Slack via webhook.`)); // eslint-disable-line
    });

    if (SLACK_CHANNEL_STALE && SLACK_CHANNEL_STALE.length) {
      SLACK_CHANNEL_STALE.forEach(sc => {
        const gkcPluralKey = GATE_KEEPER_CONFIG.find(gkc => sc.key === gkc.key).pluralKey;
        let sumry = Object.assign({}, summary);

        if (!gkcPluralKey) {
          return;
        }

        sumry = filterSignoffsByKey(summary, gkcPluralKey);
        sumry = filterOutSignedOffPRsByKey(sumry, gkcPluralKey);
        sumry = filterOutTooEarlyPRs(sumry, sc.staleMinutes);

        if (sumry.upstream && sumry.upstream.prs.length) {
          const slackMessage = slackify(sumry, true);

          slack.webhook({
            channel: sc.channel,
            username: process.env.SLACK_BOT_NAME,
            'icon_emoji': process.env.SLACK_BOT_ICON_URL,
            text: slackMessage
          }, (err, response) => {
            if (err) {
              console.log(JSON.stringify(err, null, 2));  // eslint-disable-line
              return;
            }
          });
        }
      });
    }
  })
  ;

function slackify(prSummary, excludeMentions = false) {
  if (!(prSummary.upstream && prSummary.upstream.prs.length) && !(prSummary.team && prSummary.team.prs.length)) {
    return `Currently there aren't any outstanding pull requests for ${organization.login}. _No news is good news right?_`;
  }

  const stdOutSummary = getStdOutSummary(prSummary);
  const slackSummary = getStdOutSummary(prSummary, true, excludeMentions);
  const shareSummary = !SLACK_EXCLUDE_SHARE_SUMMARY ? `\n\n_Copy and paste below to share_\n\`\`\`${stdOutSummary}\`\`\`` : '';

  return `${slackSummary}${shareSummary}`;
}

function getStdOutSummary(prSummary, slackifyLinks = false, excludeMentions = EXCLUDE_MENTIONS) {
  // console.log(JSON.stringify(prSummary, null, 2))

  const upstreamMessages = [];
  const teamMessages = [];

  upstreamMessages.push('');

  if (prSummary.upstream && prSummary.upstream.prs.length) {
    upstreamMessages.push(`${organization.login} upstream PRs`);

    prSummary.upstream.prs
      .sort((a, b) => moment(a.createdOn).format('x') - moment(b.createdOn).format('x'))
      .forEach(pr => {
        const author = !excludeMentions ? ` @${pr.author}` : '';
        const relativeCreatedOn = `${moment(pr.createdOn).fromNow()}`;

        upstreamMessages.push(`> ${buildPRLink(pr, slackifyLinks)}${author} (${relativeCreatedOn})`);

        if (pr.signoffs) {
          GATE_KEEPER_CONFIG.forEach(gkc => {
            if (pr.signoffs[gkc.pluralKey] && pr.signoffs[gkc.pluralKey].length) {
              const leadMsg = `${gkc.display}: `;
              const gatekeepers = pr.signoffs[gkc.pluralKey].map(gatekeeper => {
                if (pr.lgtm && pr.lgtm.indexOf(gatekeeper.toString()) > -1) {
                  return `~${gatekeeper}~`;
                }
                else {
                  return `_${gatekeeper}_`;
                }
              });

              upstreamMessages.push(`>    ${leadMsg}${gatekeepers.join(', ')}`);
            }
          });
        }
      });
  }
  else if (prSummary.upstream) {
    upstreamMessages.push(`${organization.login} upstream PRs`);
    upstreamMessages.push('> _none_');
  }

  if (prSummary.team && prSummary.team.prs.length) {
    teamMessages.push(`${organization.login} team PRs`);
    prSummary.team.prs
      .sort((a, b) => moment(a.createdOn).format('x') - moment(b.createdOn).format('x'))
      .forEach(pr => {
        const author = !excludeMentions ? ` @${pr.author}` : '';
        const relativeCreatedOn = `${moment(pr.createdOn).fromNow()}`;

        teamMessages.push(`> ${buildPRLink(pr, slackifyLinks)}${author} (${relativeCreatedOn})`);
      });
  }
  else if (prSummary.team) {
    teamMessages.push(`${organization.login} team PRs`);
    teamMessages.push('> _none_');
  }

  teamMessages.push('');

  return `${upstreamMessages.join('\n')}\n\n${teamMessages.join('\n')}`;
}

function reducePRs(issues) {
  return issues.reduce((arr, issues) => {
    const prs = issues
      .filter(issue => !!issue.pull_request)
      .map(pr => ({
        ownerRepo: parseOutOwnerRepo(pr.pull_request.html_url),
        url: pr.pull_request.html_url,
        author: pr.user.login,
        lastUpdated: pr.updated_at,
        createdOn: pr.created_at,
        id: pr.id,
        number: pr.number
      }))
      ;

    return arr.concat(prs);
  }, []);
}

function parseOutOwnerRepo(str) {
  const parts = str.split('/');

  return `${parts[3]}/${parts[4]}`;
}

function parseOutGateKeepers(str, gateKeeperConfig = GATE_KEEPER_CONFIG) {
  const body = (str || '').toLowerCase();
  const data = {};
  const peopleReg = /(@[a-z][a-z][a-z][a-z0-9]+)/ig;

  gateKeeperConfig.forEach(sk => {
    if (body.indexOf(sk.token) > -1) {
      const splits = body.split(sk.token);

      const interimPart = splits[1].split(sk.signOffKey)[0].trim();

      data[sk.pluralKey] = interimPart.match(peopleReg).map(mention => mention.replace('@', ''));
    }
  });

  return data;
}

function getOpts(path) {
  return {
    uri: `${process.env.GITHUB_API_BASE_URL}${path}`,
    headers: {
      'Authorization': `token ${process.env.GITHUB_TOKEN}`
    },
    json: true
  };
}

function mapToLightRepo(fullRepo) {
  return {
    owner: _.get(fullRepo, 'owner.login'),
    name: fullRepo.name
  };
}

function log(str, isNewlineWrapped = true) {
  process.stdout.write(chalk.yellow(`${str}${isNewlineWrapped ? '\n' : ''}`));
}

function convertIssueUrlToPrUrl(issueUrl) {
  // https://github.ua.com/ui/ua-grid/issues/188 // convert this
  // https://github.ua.com/ui/ua-grid/pull/188 // to this
  return issueUrl
    .replace(/api\/v3\/repos\//ig, '')
    .replace(/issues/ig, 'pull')
    ;
}

function buildPRLink(pr, slackifyUrl = false) {
  if (slackifyUrl) {
    return `<${pr.url}|${pr.ownerRepo} #${pr.number}>`;
  }
  else {
    return `${pr.url}`;
  }
}

function isTruthy(val) {
  return ['false', '0', ''].indexOf((val || '')) === -1;
}

function getDebugName(name) {
  const debugFactory = require('debug');
  const appName = require(cwd('package.json')).name;

  if (name) {
    return debugFactory(`${appName}:${name}`);
  }

  return debugFactory(appName);
}

function parseStaleChannels(rawStr) {
  const configs = [];

  if (isTruthy(rawStr) === false) {
    return configs;
  }

  rawStr
    .split(',')
    .forEach(token => {
      const parts = token.split(':');

      configs.push({
        key: parts[0],
        channel: parts[1],
        staleMinutes: parseInt(parts[2], 10) || 99999999
      });
    });

  return configs;
}

function filterOutSignedOffPRsByKey(summary, key) {
  const prsObj = Object.assign({}, summary);

  prsObj.upstream.prs = prsObj.upstream.prs.filter(pr => {
    const reqSignatures = pr.signoffs[key];

    if (!reqSignatures) {
      return false;
    }

    const foundSignature = reqSignatures.find(rs => pr.lgtm.find(lgtme => lgtme === rs));

    return !foundSignature;
  });

  return prsObj;
}

function filterSignoffsByKey(summary, key) {
  const newUpstreamObj = Object.assign({}, summary.upstream);

  const newPrs = newUpstreamObj.prs
    .filter(pr => pr.signoffs && pr.signoffs[key])
    .map(pr => {
      const newPr = Object.assign({}, pr);

      newPr.signoffs = _.pick(pr.signoffs, key);

      return newPr;
    });

  const newSummary = {
    upstream: {
      prs: newPrs
    }
  };

  return newSummary;
}

function filterOutTooEarlyPRs(summary, staleMinutes) {
  const now = moment().utc();
  const newPrs = summary.upstream.prs
    .filter(pr => {
      const staleDate = moment(pr.createdOn).add(staleMinutes, 'minute');
      const minutesAfterStaleDate = now.diff(staleDate, 'minute');

      return minutesAfterStaleDate >= 0; // If we have a positive number here, the PR is stale
    });

  const newSummary = {
    upstream: {
      prs: newPrs
    }
  };

  return newSummary;
}
