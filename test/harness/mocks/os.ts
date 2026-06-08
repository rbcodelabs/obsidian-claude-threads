// Named exports so dynamic require('os') at runtime gets the right shape.
export const homedir = () => '/Users/mock';
export const tmpdir = () => '/tmp';
export default { homedir, tmpdir };
