# tractor-pulls
A node app built to pull the open PRs for a given team (GitHub org).

![Slack](https://i.imgsafe.org/d060a1eb3f.png)

## Pre-requisites
1. Create a [GitHub token][github-token]
2. Your team members are marked as public on your team page
3. NodeJs v6+

## Getting started

### In the cloud...
[![Deploy](https://www.herokucdn.com/deploy/button.svg)](https://heroku.com/deploy)

#### Setup a schedule via Heroku Scheduler
1. On your new app overview, click on Heroku Scheduler
![Heroku Scheduler](https://i.imgsafe.org/32c3b96fdc.png)
2. Add a job and schedule with the command: `npm run pulls`
![Add Job](https://i.imgsafe.org/3d83446416.png)
3. All done.

### - OR -

### Locally...
1. `npm i`
2. `cat .env.sample > .env`
3. Fill out values in `.env`
4. `npm run pulls`

![Output](https://i.imgsafe.org/d0622c0dd4.png)

[github-token]:https://help.github.com/articles/creating-an-access-token-for-command-line-use
