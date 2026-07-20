#!/bin/bash
rm *.vsix
pm package
touch run-production.trigger
