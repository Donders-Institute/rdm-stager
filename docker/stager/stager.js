var config = require('config');
var kue = require('kue');
var cluster = require('cluster'); 
var kill = require('tree-kill');
var bodyParser = require('body-parser');
var posix = require('posix');
var child_process = require('child_process')
var queue = kue.createQueue({
    redis: {
        port: 6379,
        host: '127.0.0.1'
    }
});
var path = require('path');

var active_pids = {};

const stager_bindir = __dirname + path.sep + 'bin';

queue.on( 'error', function(err) {
    if ( cluster.isMaster) { 
        console.error('Oops... ', err);
    }
}).on( 'job enqueue', function(id, type) {
    if ( cluster.isMaster) { 
        console.log('[' + new Date().toISOString() + '] job %d enqueued for %s', id, type);
    }
}).on( 'job complete', function(id, result) {
    if ( cluster.isMaster) {
        console.log('[' + new Date().toISOString() + '] job %d complete', id);
    }
}).on( 'job failed attempt', function(id, err, nattempts) {
    if ( cluster.isMaster) {
        console.log('[' + new Date().toISOString() + '] job %d failed, attempt %d', id, nattempts); 
    }
}).on( 'job failed' , function(id, err) {
    if ( cluster.isMaster) {
        console.log('[' + new Date().toISOString() + '] job %d failed', id);
    }
}).on( 'job remove', function(id, err) {
    if ( cluster.isMaster) {
        var pinfo = active_pids[id];
        if ( ! (pinfo === undefined) ) {
            // inform worker to kill the process
            pinfo['worker'].send({'type': 'KILL', 'pid': pinfo['pid'], 'jid': id});
        }
        delete active_pids[id];
        console.log('[' + new Date().toISOString() + '] job %d removed', id);
    }
});

if (cluster.isMaster) {

    // set up express app 
    var express = require('express');
    var app = express();

    // basicAuth 
    var auth = require('./routes/auth'); 
    app.use(auth.basicAuthAD);

    // bodyParser so that FORM data become available in req.body 
    app.use(bodyParser.json());
    app.use(bodyParser.urlencoded({ extended: false }));

    // start service for RESTful APIs
    app.use(kue.app);

    // expose stager's local filesystem 
    var stager_fstree = require('./routes/stager_fstree_sftp'); 
    app.post('/fstree/stager', stager_fstree.getDirList);

    //var rdm_fstree = require('./routes/rdm_fstree_restful');
    //app.post('/fstree/rdm', rdm_fstree.getDirList);

    var stager_fslogin = require('./routes/stager_fslogin_sftp');
    app.post('/fslogin/stager', stager_fslogin.authenticateUser);

    //var rdm_fslogin = require('./routes/rdm_fslogin_restful');
    //app.post('/fslogin/rdm', rdm_fslogin.authenticateUser);

    app.listen(3000);

    // fork workers
    var nworkers = require('os').cpus().length - 1;
    for (var i = 0; i < nworkers; i++) {
        var w = cluster.fork();
        w.on('message', function(msg) {
            if ( msg['type'] == 'START' ) {
                active_pids[msg['jid']] = {'worker': this, 'pid': msg['pid']};
                console.log('[' + new Date().toISOString() + '] job %s run by worker %s:%s', msg['jid'], active_pids[msg['jid']]['worker'].id, active_pids[msg['jid']]['pid']);
            } else {
                delete active_pids[msg['jid']];
            }
        });
    }

} else {

    process.on('message', function(msg) {
        if ( msg['type'] == 'KILL' ) {
            kill(msg['pid'], 'SIGKILL', function(err) {
                console.log( '[' + new Date().toISOString() + '] job ' + msg['jid'] + ' killed upon user removal');
            });
        }
    });

    queue.process("rdm", function(job, done) {

        var domain = require('domain').create();
 
        domain.on('error', function(err) {
            done(err);
        });
 
        domain.run( function() {
            if ( job.data.srcURL === undefined || job.data.dstURL === undefined ) {
                console.log('[' + new Date().toISOString() + '] job %d ignored: invalid arguments', job.id);
                done();
            } else {
                // get fresh One-time password for job.data.rdmUser
                var cmd = stager_bindir + path.sep + 's-otp.sh';
                var out = child_process.execFileSync( cmd, [ job.data.rdmUser ]);
                var rdmPass = out.toString().split('\n')[0];
                // throw error if rdmPass is not a 6-digit number 
                if ( ! rdmPass.match('^[0-9]{6}$') ) {
                    throw new Error('invalid OTP for user: ' + job.data.rdmUser);
                }
             
                // TODO: make the logic implementation as a plug-in
                if ( job.data.clientIF === undefined || job.data.clientIF == 'irods' ) {
                    cmd = stager_bindir + path.sep + 's-irsync.sh';
                } else {
                    cmd = stager_bindir + path.sep + 's-duck.sh';
                }

                var cmd_args = [ job.data.srcURL, job.data.dstURL, job.data.rdmUser, rdmPass ];
                var cmd_opts = {
                    maxBuffer: 10*1024*1024
                };

                if ( typeof job.data.stagerUser !== "undefined" ) {
                    proc_user = posix.getpwnam(job.data.stagerUser.split('@')[0]);
                    cmd_opts.uid = proc_user.uid;
                    cmd_opts.gid = proc_user.gid;
                }

                var job_timeout_err;
                var job_stopped = false;
                var sec_noprogress = 0;
                var child = child_process.execFile(cmd, cmd_args, cmd_opts, function(err, stdout, stderr) {
                    // push the last 5-lines of stdout to job log
                    job.log({"stdout": stdout.split("\n").slice(-5)});
                    // error handling
                    if (err) { throw new Error(stderr); }
                    done(null, stdout);
                });

                // inform master the job has been started
                process.send({'type':'START', 'jid': job.id, 'pid': child.pid});

                // define callback when data piped to child.stdout
                child.stdout.on('data', function(data) {
                    // use the child process's output to update job's progress
                    job.progress(parseInt(data.trim()), 100);
                    // reset noprogress time counter 
                    sec_noprogress = 0;
                });

                child.stdout.on('error', function(err) {
                    console.log("error on stdout");
                });

                child.stderr.on('error', function(err) {
                    console.log("error on stderr");
                });

                // define callback when child process exits
                child.on( "exit", function(code, signal) {
                    // set interal flag indicating the job has been stopped
                    job_stopped = true;
                    // inform master the job has been stopped
                    process.send({'type':'STOP', 'jid': job.id});
                    // interruption handling (null if process is not interrupted) 
                    if ( signal != null ) {
                        if ( job_timeout_err === undefined ) {
                            throw new Error('job terminated by ' + signal);
                        } else {
                            throw new Error('job terminated by ' + signal + ':' + job_timeout_err );
                        }
                    }
                });

                // determine job timeout 
                var timeout;
                if ( job.data.timeout === undefined || job.data.timeout <= 0 ) {
                    // no timeout
                    timeout = Number.MAX_SAFE_INTEGER;  
                } else {
                    timeout = job.data.timeout;
                }

                var timeout_noprogress;
                if ( job.data.timeout_noprogress === undefined || job.data.timeout_noprogress <= 0 ) {
                    // no timeout
                    timeout_noprogress = 3600;  
                } else {
                    timeout_noprogress = job.data.timeout_noprogress;
                }

                // initiate a monitor loop (timer) for heartbeat check on job status/progress
                var t_beg = new Date().getTime() / 1000;
                var timer = setInterval( function() {
                    if ( ! job_stopped ) {
                        if ( sec_noprogress > timeout_noprogress ) {
                            // job does not have any progress within an expected duration 
                            child.stdin.pause();
                            kill(child.pid, 'SIGKILL', function(err) {
                                job_timeout_err = 'no progress for ' + timeout_noprogress + 's';
                                console.log( '[' + new Date().toISOString() + '] job ' + job.id + ' killed due to no progress for ' + timeout_noprogress + 's' );
                            });
                        } else if ( new Date().getTime()/1000 - t_beg > timeout ) {
                            // job is running over the expected duration
                            child.stdin.pause();
                            kill(child.pid, 'SIGKILL', function(err) {
                                job_timeout_err = 'job timeout (> ' + timeout + 's)';
                                console.log( '[' + new Date().toISOString() + '] job ' + job.id + ' killed due to timout (> ' + timeout + 's)');
                            });
                        } else {
                            // job doesn't reach any timeout, continue with nopgress time counter increased by 1 second 
                            sec_noprogress += 1;
                        }
                    } else {
                        // stop the timer if job is stopped 
                        clearInterval(timer);
                    }
                }, 1000 );
            }
        });
    });
}

// graceful queue shutdown
function shutdown() {
    if ( cluster.isMaster ) {
        queue.shutdown( 60000, function(err) {
            console.log( 'Kue shutdown: ', err||'' );
            process.exit( 0 );
        });
    }
}

process.once( 'SIGTERM', function(sig) { shutdown(sig); } );
process.once( 'SIGINT', function(sig) { shutdown(sig); } );