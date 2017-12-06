var fs = require('fs');
var os = require('os');
var path = require('path');
var config = require('config');
var auth = require('basic-auth');
var child_process = require('child_process');
var querystring = require('querystring');
var _utility = require('./utility');

/* check if cifs is mounted */
var _cifsIsMounted = function( tgt ) {

    var p = os.platform();
    var cmd_opts = {
        shell: '/bin/bash',
        timeout: 10000
    };

    if ( p == 'linux') {
        var cmd = 'grep';
        var cmd_args = ['-qs', tgt, '/proc/mounts'];
        try {
            // the following call should throw error if exit code is non-zero
            // thus, if it is passed, it implies the target is a mount
            child_process.execFileSync( cmd, cmd_args, cmd_opts );
            return true;
        } catch (err) {
            console.error(err);
            return false;
        }
    } else if ( p == 'freebsd' || p == 'darwin' ) {
        var cmd = 'mount';
        var cmd_args = [];
        try {
            var out = child_process.execFileSync( cmd, cmd_args, cmd_opts );
            // find in the mount output to see if the target is presented
            return ( out.indexOf(tgt) > -1 )
        } catch (err) {
            console.error(err);
            return false;
        }
    } else {
        return true;
    }
}

/* mount cifs */
var _cifsMountAsync = function( cfg, cb ) {

    var mnt_tgt = path.join(cfg.mount, cfg.username);

    if ( ! fs.existsSync(mnt_tgt) ) {
        fs.mkdirSync(mnt_tgt);
    }

    if ( ! _cifsIsMounted(mnt_tgt) ) {
        var mnt_src = '//' + cfg.username + ':' + querystring.escape(cfg.password) +
                      '@'  + cfg.server   + '/' + cfg.share;

        var cmd = 'mount';
        var cmd_args = [ "-t", "smbfs", mnt_src, mnt_tgt ];
        var cmd_opts = {
            shell: '/bin/bash',
            timeout: 10000
        };
        child_process.execFile( cmd, cmd_args, cmd_opts, cb );
    } else {
        cb(null, 'target alreay a mount: ' + mnt_tgt, '')
    }
}

var _cifsUnmountAsync = function( cfg, cb ) {

}

/* authenticate filesystem user */
var _authenticateUser = function(request, response) {
    // dummy response as when this function is called, the authentication is passed
    response.status(200);
    response.json({});
}

/* get files and directories within a filesystem directory */
var _getDirList = function(request, response) {

    var cfg = { server: config.get('StagerLocal.cifs.server'),
                share: config.get('StagerLocal.cifs.share'),
                mount: config.get('StagerLocal.cifs.mount'),
                username: auth(request).name.toLowerCase(),
                password: auth(request).pass };

    var f_data = [];

    // try to mount the CIFS endpoint
    _cifsMountAsync(cfg, function(err, stdout, stderr) {
        if (err) {
            // mount failed
            console.error('Cannot mount: ' + err + ' - ' + stderr);
        } else {
            // mount successful or already existing
            //var dir = request.body.dir == '/' ? path.join(cfg.mount, auth(request).name) + '/':request.body.dir;
            var dir = request.body.dir.replace(/^\//, path.join(cfg.mount, cfg.username) + '/');
            try {
                var files = fs.readdirSync(dir);
                files.forEach(function(f){
                    var ff = dir + f;
                    // only list those readable
                    try {
                        //this filter out non-accessible folders/files;
                        //but it slows down the listing
                        //
                        //fs.accessSync(ff, fs.R_OK);

                        var lstat = fs.lstatSync(ff);

                        switch ( true ) {
                            case lstat.isDirectory():
                                f_data.push( { 'name': f, 'type': 'd', 'size': 0 } );
                                break;

                            case lstat.isSymbolicLink():
                                // resolve symbolic link to the physical location
                                var stat = fs.statSync(fs.realpathSync(ff));
                                if ( stat.isDirectory() ) {
                                    f_data.push( { 'name': f, 'type': 'd', 'size': 0 } );
                                } else {
                                    f_data.push( { 'name': f, 'type': 'f', 'size': stat.size } );
                                }
                                break;
                            default:
                                f_data.push( { 'name': f, 'type': 'f', 'size': lstat.size } );
                                break;
                        }
                    } catch(e) {
                        console.error('Cannot stat file: ' + ff);
                        console.error(e);
                    }
                });
            } catch(e) {
                console.error('Cannot load directory: ' + dir);
                console.error(e);
            }
        }
        response.contentType('application/json');
        response.send(f_data);
    });
}

module.exports.authenticateUser = _authenticateUser;
module.exports.getDirList = _getDirList;
