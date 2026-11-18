const fs = require('node:fs/promises');
const path = require('node:path');
const {withDangerousMod} = require('expo/config-plugins');

module.exports = function withWrapperIntegrity(config) {
  return withDangerousMod(config, ['android', async mod => {
    const file = path.join(mod.modRequest.platformProjectRoot, 'gradle/wrapper/gradle-wrapper.properties');
    let value = await fs.readFile(file, 'utf8');
    value = value.replace(/^networkTimeout=.*$/m, 'networkTimeout=60000');
    const checksum = 'distributionSha256Sum=bd71102213493060956ec229d946beee57158dbd89d0e62b91bca0fa2c5f3531';
    value = value.match(/^distributionSha256Sum=/m) ? value.replace(/^distributionSha256Sum=.*$/m, checksum) : `${value.trimEnd()}\n${checksum}\n`;
    await fs.writeFile(file, value);
    return mod;
  }]);
};
