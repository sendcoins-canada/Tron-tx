const chalk = require('chalk');

function timestamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

const logger = {
  info(msg) {
    console.log(chalk.gray(`[${timestamp()}]`), chalk.blue('INFO'), msg);
  },
  success(msg) {
    console.log(chalk.gray(`[${timestamp()}]`), chalk.green('OK'), msg);
  },
  warn(msg) {
    console.log(chalk.gray(`[${timestamp()}]`), chalk.yellow('WARN'), msg);
  },
  error(msg) {
    console.log(chalk.gray(`[${timestamp()}]`), chalk.red('ERR'), msg);
  },
  step(n, title) {
    console.log('\n' + chalk.cyan.bold(`STEP ${n}: ${title}`));
    console.log(chalk.cyan('─'.repeat(50)));
  },
  table(label, value) {
    console.log(`  ${chalk.white(label.padEnd(20))} ${chalk.yellow(value)}`);
  },
};

module.exports = logger;
