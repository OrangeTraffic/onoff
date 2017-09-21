"use strict";

const fs = require('fs');
const Epoll = require('epoll').Epoll;
const waitForExportToComplete = require('./waitForExportToComplete');

var GPIO_ROOT_PATH = '/sys/class/gpio/',
  ZERO = new Buffer('0'),
  ONE = new Buffer('1');

exports.version = '1.1.7';

function pollerEventHandler(err, fd, events) {
  const value = this.readSync();
  const callbacks = this.listeners.slice(0);

  if (this.opts.debounceTimeout > 0) {
    setTimeout(function () {
      if (this.listeners.length > 0) {
        // Read current value before polling to prevent unauthentic interrupts.
        this.readSync();
        this.poller.modify(this.valueFd, Epoll.EPOLLPRI | Epoll.EPOLLONESHOT);
      }
    }.bind(this), this.opts.debounceTimeout);
  }

  callbacks.forEach((callback) => {
    callback(err, value);
  });
}

/**
 * Constructor. Exports a GPIO to userspace.
 *
 * The constructor is written to function for both superusers and
 * non-superusers. See README.md for more details.
 *
 * gpio: number      // The Linux GPIO identifier; an unsigned integer.
 * direction: string // Specifies whether the GPIO should be configured as an
 *                   // input or output. The valid values are: 'in', 'out',
 *                   // 'high', and 'low'. 'high' and 'low' are variants of
 *                   // 'out' that configure the GPIO as an output with an
 *                   // initial level of high or low respectively.
 * [edge: string]    // The interrupt generating edge for the GPIO. Can be
 *                   // specified for GPIO inputs and outputs. The edge
 *                   // specified determine what watchers watch for. The valid
 *                   // values are: 'none', 'rising', 'falling' or 'both'.
 *                   // The default value is 'none'. [optional]
 * [options: object] // Additional options. [optional]
 *
 * The options argument supports the following:
 * debounceTimeout: number  // Can be used to software debounce a button or
 *                          // switch using a timeout. Specified in
 *                          // milliseconds. The default value is 0.
 * activeLow: boolean       // Specifies whether the values read from or
 *                          // written to the GPIO should be inverted. The
 *                          // interrupt generating edge for the GPIO also
 *                          // follow this this setting. The valid values for
 *                          // activeLow are true and false. Setting activeLow
 *                          // to true inverts. The default value is false.
 */
function Gpio(gpio, direction, edge, _options = {}) {

  if (!(this instanceof Gpio)) {
    return new Gpio(gpio, direction, edge, _options);
  }

  let options = _options;
  this.requestedEdge = edge;

  if (typeof edge === 'object' && _options === undefined) {
    // Parameter's shift -> 3 options signature, (gpio, direction, options)
    options = edge;
    this.requestedEdge = undefined;
  }

  this.gpio = gpio;
  this.requestedDirection = direction;
  this.requestedOptions = options;
  this.gpioPath = GPIO_ROOT_PATH + 'gpio' + this.gpio + '/';
  this.opts = {};
  this.opts.debounceTimeout = options.debounceTimeout || 0;
  this.readBuffer = new Buffer(16);
  this.listeners = [];
  this.initCompleted = false;
  this.initCalled = false;

  if (!fs.existsSync(this.gpioPath)) {
    // The pin hasn't been exported yet so export it.
    fs.writeFileSync(GPIO_ROOT_PATH + 'export', this.gpio);
  }
}

exports.Gpio = Gpio;

Gpio.prototype.init = async function init() {
  if (this.initCompleted || this.initCalled) return;
  this.initCalled = true;

  await waitForExportToComplete(this.gpioPath, this.requestedEdge);

  try {
    fs.writeFileSync(this.gpioPath + 'direction', this.requestedDirection);
  } catch (ignore) { }
  if (this.requestedEdge) {
    try {
      fs.writeFileSync(this.gpioPath + 'edge', this.requestedEdge);
    } catch (ignore) { }
  }
  try {
    fs.writeFileSync(this.gpioPath + 'active_low', !!this.requestedOptions.activeLow ? ONE : ZERO);
  } catch (ignore) { }

  // Cache fd for performance.
  this.valueFd = fs.openSync(this.gpioPath + 'value', 'r+');

  // Read current value before polling to prevent unauthentic interrupts.
  this.readSync();

  this.poller = new Epoll(pollerEventHandler.bind(this));
  this.initCompleted = true;
};

/**
 * Read GPIO value asynchronously.
 *
 * [callback: (err: error, value: number) => {}] // Optional callback
 */
Gpio.prototype.read = function read(callback) {
  fs.read(this.valueFd, this.readBuffer, 0, 1, 0, function (err, bytes, buf) {
    if (typeof callback === 'function') {
      if (err) {
        return callback(err);
      }

      callback(null, buf[0] === ONE[0] ? 1 : 0);
    }
  });
};

/**
 * Read GPIO value synchronously.
 *
 * Returns - number // 0 or 1
 */
Gpio.prototype.readSync = function () {
  fs.readSync(this.valueFd, this.readBuffer, 0, 1, 0);
  return this.readBuffer[0] === ONE[0] ? 1 : 0;
};

/**
 * Write GPIO value asynchronously.
 *
 * value: number                  // 0 or 1
 * [callback: (err: error) => {}] // Optional callback
 */
Gpio.prototype.write = function (value, callback) {
  var writeBuffer = value === 1 ? ONE : ZERO;
  fs.write(this.valueFd, writeBuffer, 0, writeBuffer.length, 0, callback);
};

/**
 * Write GPIO value synchronously.
 *
 * value: number // 0 or 1
 */
Gpio.prototype.writeSync = function (value) {
  var writeBuffer = value === 1 ? ONE : ZERO;
  fs.writeSync(this.valueFd, writeBuffer, 0, writeBuffer.length, 0);
};

/**
 * Watch for hardware interrupts on the GPIO. Inputs and outputs can be
 * watched. The edge argument that was passed to the constructor determines
 * which hardware interrupts are watcher for.
 *
 * Note that the value passed to the callback does not represent the value of
 * the GPIO the instant the interrupt occured, it represents the value of the
 * GPIO the instant the GPIO value file is read which may be several
 * milliseconds after the actual interrupt. By the time the GPIO value is read
 * the value may have changed. There are scenarios where this is likely to
 * occur, for example, with buttons or switches that are not hadrware
 * debounced.
 *
 * callback: (err: error, value: number) => {}
 */
Gpio.prototype.watch = function (callback) {
  var events;

  this.listeners.push(callback);

  if (this.listeners.length === 1) {
    events = Epoll.EPOLLPRI;
    if (this.opts.debounceTimeout > 0) {
      events |= Epoll.EPOLLONESHOT;
    }
    this.poller.add(this.valueFd, events);
  }
};

/**
 * Stop watching for hardware interrupts on the GPIO.
 */
Gpio.prototype.unwatch = function (callback) {
  if (this.listeners.length > 0) {
    if (typeof callback !== 'function') {
      this.listeners = [];
    } else {
      this.listeners = this.listeners.filter(function (listener) {
        return callback !== listener;
      });
    }

    if (this.listeners.length === 0) {
      this.poller.remove(this.valueFd);
    }
  }
};

/**
 * Remove all watchers for the GPIO.
 */
Gpio.prototype.unwatchAll = function () {
  this.unwatch();
};

/**
 * Get GPIO direction.
 *
 * Returns - string // 'in', or 'out'
 */
Gpio.prototype.direction = function () {
  return fs.readFileSync(this.gpioPath + 'direction').toString().trim();
};

/**
 * Set GPIO direction.
 *
 * direction: string // Specifies whether the GPIO should be configured as an
 *                   // input or output. The valid values are: 'in', 'out',
 *                   // 'high', and 'low'. 'high' and 'low' are variants of
 *                   // 'out' that configure the GPIO as an output with an
 *                   // initial level of high or low respectively.
 */
Gpio.prototype.setDirection = function (direction) {
  fs.writeFileSync(this.gpioPath + 'direction', direction);
};

/**
 * Get GPIO interrupt generating edge.
 *
 * Returns - string // 'none', 'rising', 'falling' or 'both'
 */
Gpio.prototype.edge = function () {
  return fs.readFileSync(this.gpioPath + 'edge').toString().trim();
};

/**
 * Set GPIO interrupt generating edge.
 *
 * edge: string // The interrupt generating edge for the GPIO. Can be
 *              // specified for GPIO inputs and outputs. The edge
 *              // specified determine what watchers watch for. The valid
 *              // values are: 'none', 'rising', 'falling' or 'both'.
 */
Gpio.prototype.setEdge = function (edge) {
  fs.writeFileSync(this.gpioPath + 'edge', edge);
};

/**
 * Get GPIO activeLow setting.
 *
 * Returns - boolean
 */
Gpio.prototype.activeLow = function () {
  return fs.readFileSync(this.gpioPath + 'active_low')[0] === ONE[0];
};

/**
 * Set GPIO activeLow setting.
 *
 * invert: boolean // Specifies whether the values read from or
 *                 // written to the GPIO should be inverted. The
 *                 // interrupt generating edge for the GPIO also
 *                 // follow this this setting. The valid values for
 *                 // activeLow are true and false. Setting activeLow
 *                 // to true inverts. The default value is false.
 */
Gpio.prototype.setActiveLow = function (invert) {
  fs.writeFileSync(this.gpioPath + 'active_low', !!invert ? ONE : ZERO);
};

/**
 * Get GPIO options.
 *
 * Returns - object // Must not be modified
 */
Gpio.prototype.options = function () {
  return this.opts;
};

/**
 * Reverse the effect of exporting the GPIO to userspace. The Gpio object
 * should not be used after calling this method.
 */
Gpio.prototype.unexport = function () {
  this.unwatchAll();
  fs.closeSync(this.valueFd);
  try {
    fs.writeFileSync(GPIO_ROOT_PATH + 'unexport', this.gpio);
  } catch (ignore) {
    // Flow of control always arrives here when cape_universal is enabled on
    // the bbb.
  }
};
