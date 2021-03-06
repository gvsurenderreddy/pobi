var net = require('net')
  , dns = require('dns')
  , url = require('url')
  , http = require('http')
  , gfw = require('./gfw')
  , proto = require('./proto')
  , debug = require('./debug')('HTTP');

// ---- timeout

var CONTIMEOUT = 3000; // 3 second
var ESTTIMEOUT = 5000; // 5 second

var app = process.env.npm_config_app || 'local';

// ----

function resolve(domain, callback){
  dns.resolve4(domain, function(e, ips){
    if (e || ips.length == 0) {
      return callback(e);
    }
    var r = {};
    for (var i=0; i<ips.length; i++){
      var ip = ips[i];
      r[ip] = gfw.identifyIp(domain, ip);
    }
    for (var ip in r) {
      if (r[ip] == 'white') {
	return callback(null, ip, 'white');
      }
    }
    for (var ip in r) {
      if (r[ip] == 'gray') {
	return callback(null, ip, 'gray');
      }
    }
    for (var ip in r) {
      if (r[ip] == 'black') {
	return callback(null, ip, 'black');
      }
    }
    var e = new Error('resolve fail');
    e.code = 'ENODATA';
    callback(e);
  });
}

// tunnel /// https going this way
function tunnel(req, sock, head){
  var self = this;
  var host = url.parse('http://'+req.url).hostname;
  // var domainColor = (app != 'local') ? 'white' : gfw.identifyDomain(host);
  resolve(host, function(e, ip, ipColor){
    // var color = (ipColor == 'white' || domainColor == 'white') ? 'white' : 'black';
    _tunnel.call(self, ip, ipColor, req, sock, head);
  });
}

function _tunnel(ip, color, req, sock, head){

  // debug('%s : tunnel [%s] %s CON ING %s', req.ip, color, req.url, server.connections);

  if (color == 'fail' || color == undefined || ip == undefined) {
    sock.end('HTTP/1.0 500 Connect fail\r\n\r\n\r\n');
    return;
  }

  var self = this;
  var o = url.parse('http://'+req.url);
  var upstream = (color == 'black') ? self.upstream : self.direct;
  // var usock = upstream.createConnection(o.port, o.hostname);
  var usock = upstream.createConnection(o.port, ip);
  var uend = null;
  var uest = false;

  function endup(e){
    if (uend) return; else uend = e || true; // do not process error again
    try { usock.destroy(); } catch(x) { }
    if (uest) {
      try { sock.destroy(); } catch(x){ }
    }
    var us = uest ? 'EST' : 'CON';
    if (!e) {
      // debug('%s : tunnel [%s] %s %s END OK', req.ip, color, req.url, us);
    } else if (!uest && e.code == 'ETIMEOUT') {
      debug('%s : tunnel [%s] %s %s TIMEOUT RETRY', req.ip, color, req.url, us);
      if (color == 'black') {
	gfw.identifyIp(o.hostname, ip, 'fail');
	// retry with redo dns resolve
	tunnel.call(self, req, sock, head);
      } else {
	gfw.identifyIp(o.hostname, ip, 'black');
	// retry same ip
	_tunnel.call(self, ip, 'black', req, sock, head);
      }
    } else {
      debug('%s : tunnel [%s] %s %s FAIL %s', req.ip, color, req.url, us, e.code);
      if (!uest) gfw.identifyIp(o.hostname, ip, 'fail');
      sock.end('HTTP/1.0 500 Connect fail\r\n\r\n\r\n');
    }
  }
  function timeout(){
    var e = new Error('connect timeout');
    e.code = 'ETIMEOUT';
    endup(e);
  }

  usock.setTimeout(CONTIMEOUT, timeout);
  usock.on('error', endup);

  usock.on('connect', function(){

    // debug('%s : tunnel [%s] %s EST BEGIN', req.ip, color, req.url);

    // connect ok, confirm the color
    gfw.identifyIp(o.hostname, ip, (color == 'black') ? 'black' : 'white');

    uest = true; // now connected

    usock.setTimeout(ESTTIMEOUT);
    usock.setNoDelay(true);
    usock.write(head);
    sock.pipe(usock);

    sock.setTimeout(ESTTIMEOUT, timeout);
    sock.setNoDelay(true);
    sock.on('error', endup);
    sock.on('end', endup);
    sock.write('HTTP/1.1 200 Connection Established\r\n'+
      'Proxy-agent: Pobi-Http-Proxy\r\n'+
      '\r\n');
    usock.write(head);
    usock.pipe(sock);
  });
}

// ----

function proxy(req, res){
  var self = this;
  req.pause(); // pause data to prevent lost, after connect resume
  var host = url.parse(req.url).hostname;
  // var urlColor = (app != 'local') ? 'white' : gfw.identifyUrl(host, req.url);
  resolve(host, function(e, ip, ipColor){
    // var color = (ipColor == 'black' || urlColor == 'black') ? 'black' : 'white';
    _proxy.call(self, ip, ipColor, req, res);
  });
}

function _proxy(ip, color, req, res){
  // debug('%s : proxy [%s] %s %s CON ING %s', req.ip, color, req.method, req.url, server.connections);

  if (color == 'fail' || color == undefined || ip == undefined) {
    res.statusCode = 500;
    res.end(color);
    return;
  }

  var self = this;
  var o = url.parse(req.url);
  // if (o.hostname == 'ocsp.digicert.com') console.dir(req.headers); // buggy
  var upstream = (color == 'black') ? self.upstream : self.direct;

  // expose ip
  // var headers = req.headers;
  // headers['X-Forwarded-Proto'] = "http";
  // if (headers['X-Forwarded-For']){
  //    headers['X-Forwarded-For'] += ', '+req.ip;
  // } else {
  //    headers['X-Forwarded-For'] = req.ip;
  // }

  var uend = null;
  var uest = false;
  var ureq = http.request( {
    host: ip, // o.hostname,
    port: o.port,
    path: o.path,
    method: req.method,
    headers: req.headers, // headers
    agent: upstream.agent // using the upstream
    // agent: false, // using the original http
  });

  function endup(e){
    if (uend) return; else uend = e || true; // do not process error again
    try { ureq.abort(); } catch(x){ }
    if (uest){ try { res.end(); } catch(x){ } }
    var us = uest ? 'EST' : 'CON';
    if (!e) {
      // debug('%s : proxy [%s] %s %s %s END OK', req.ip, color, req.method, req.url, us);
    } else if (!uest && color != 'black' && e.code == 'ECONNRESET') {
      // it's a reset url
      debug('%s : proxy [%s] %s %s %s RESET RETRY', req.ip, color, req.method, req.url, us);
      gfw.identifyIp(o.hostname, ip, 'black');
      // proxy.call(self, req, res);
      // retry with same ip
      _proxy.call(self, ip, 'black', req, res);
    } else if (!uest && e.code == 'ETIMEOUT') {
      // it's could be blackholed ip
      debug('%s : proxy [%s] %s %s %s TIMEOUT RETRY', req.ip, color, req.method, req.url, us);
      if (color == 'black') {
	gfw.identifyIp(o.hostname, ip, 'fail');
	// retry with redo dns resolve
	proxy.call(self, req, res);
      } else {
	gfw.identifyIp(o.hostname, ip, 'black');
	// retry with same ip
	_proxy.call(self, ip, 'black', req, res);
      }
    } else {
      debug('%s : proxy [%s] %s %s %s FAIL %s',	req.ip, color, req.method, req.url, us, e.code);
      if (!uest) gfw.identifyIp(o.hostname, ip, 'fail');
      res.statusCode = 500;
      res.end(e.code);
    }
  }
  function timeout(){
    var e = new Error('connect timeout');
    e.code = 'ETIMEOUT';
    endup(e);
  }

  // ureq.setTimeout(CONTIMEOUT, timeout); // doesn't work
  ureq.on('socket', function(socket){
    socket.setTimeout(CONTIMEOUT, timeout);
    socket.on('error', endup);
    socket.on('connect', function(){
      req.resume(); // when connect, resume to pipe to ureq
    });
  });

  ureq.on('response', function(ures){
    uest = true; // now connected
    // debug('%s : proxy [%s] %s %s EST BEGIN', req.ip, color, req.method, req.url);
    // connect ok, confirm the color
    gfw.identifyIp(o.hostname, ip, (color == 'black') ? 'black' : 'white');
    // should be but maybe too much
    gfw.identifyUrl(o.hostname, req.url, (color == 'black') ? 'black' : 'white');

    ureq.setTimeout(ESTTIMEOUT);
    req.pipe(ureq);
    try {
      res.statusCode = ures.statusCode;
      for(var k in ures.headers){ res.setHeader(k,ures.headers[k]); }
    } catch(x) { }
    ures.pipe(res);
    ures.on('error', endup);
    ures.on('end', endup);
  });

  req.on('error', endup); // in case of client ends first
  ureq.on('error', endup);
  ureq.on('end', endup);

  if (req.method == 'GET') {
    ureq.end();
  } else {
    req.pipe(ureq);
  }
}

// ----

var server = null;

function start(config){
  var onListening = function(){
    debug("listening on %s:%s",
      this.address().address, this.address().port);
    debug("  --upstream=%j", this.upstream.config);
  };
  var onRequest = function(req, res){
    var self = this;
    req.ip = req.connection.remoteAddress;
    proxy.call(this, req, res);
  };
  var onConnect = function(req, sock, head){
    var self = this;
    req.ip = req.connection.remoteAddress;
    tunnel.call(this, req, sock, head);
  };
  var onClose = function(){
    debug("closed %j", this.address());
  };
  var onError = function(err){
    debug("error %j", err);
  };

  // init
  server = http.createServer();
  server.on('listening', onListening);
  server.on('request', onRequest);
  server.on('connect', onConnect);
  server.on('close', onClose);
  server.on('error', onError);

  server.direct = proto('direct://');
  server.upstream = proto(config.upstream);

  var o = url.parse(config.listen);
  var host = o.hostname || '0.0.0.0';
  var port = o.port || 8080;

  server.listen(port, host);
}
exports.start = start;

function stop(){
  server.close();
}
exports.stop = stop;